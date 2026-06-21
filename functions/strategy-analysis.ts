// Edge function: options strategist.
//
// Frontend pre-computes a regime classification (IV-richness via IV/HV,
// skew bias, term structure, flow bias, premium posture) and a per-horizon
// snapshot of quoted contracts at standard delta points. We hand that to
// the LLM and ask for 3 strategy proposals as a strict JSON object.
//
// The LLM call goes to OpenRouter via the OpenAI-compatible SDK (same
// transport as trading-tick). Structured outputs are enforced through
// response_format.json_schema with strict:true, so message.content is
// guaranteed to be valid JSON matching STRATEGY_SCHEMA.
//
// Auth: caller must present a real user JWT — we verify it by calling
// InsForge's /api/auth/sessions/current with the caller's token and
// rejecting if no user comes back (which is what happens for the anon key
// and for invalid/expired tokens). This prevents random anon-key holders
// from burning the project's OpenRouter credits.
//
// Methodology is a synthesis of public, widely-cited frameworks:
//  - TastyTrade premium-selling rules (sell premium when vol is rich; 16Δ
//    short legs at 30-45 DTE; 50% profit target; manage at 21 DTE).
//  - Option Alpha / Project Option strategy rubrics (regime → strategy fit).
//  - Sheldon Natenberg's "Option Volatility & Pricing" framing (volatility
//    view first, direction second, structure third).

import OpenAI from "npm:openai@^4";
import { PostHog } from "npm:posthog-node";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STRATEGY_SCHEMA = {
  name: "options_strategy_set",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      regime_summary: { type: "string" },
      primary_view: {
        type: "object",
        additionalProperties: false,
        properties: {
          volatility: { type: "string", enum: ["long_vol", "short_vol", "neutral_vol"] },
          direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
        },
        required: ["volatility", "direction"],
      },
      strategies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            structure: {
              type: "string",
              enum: [
                "income_short_vol",
                "income_short_vol_one_sided",
                "debit_long_vol",
                "debit_directional",
                "calendar_diagonal",
                "hedging_collar",
                "naked_premium_sell",
                "covered_yield",
              ],
            },
            bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
            vol_view: { type: "string", enum: ["long_vol", "short_vol", "neutral_vol"] },
            horizon_tag: { type: "string", enum: ["near_14d", "primary_35d", "long_90d"] },
            legs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  action: { type: "string", enum: ["buy", "sell"] },
                  right: { type: "string", enum: ["call", "put"] },
                  symbol: { type: "string", description: "OCC symbol from the input snapshot" },
                  strike: { type: "number" },
                  expiration: { type: "string", description: "YYYY-MM-DD" },
                  delta: { type: "number" },
                  qty: { type: "number" },
                },
                required: ["action", "right", "symbol", "strike", "expiration", "delta", "qty"],
              },
            },
            credit_or_debit: { type: "string", enum: ["credit", "debit"] },
            estimated_credit_or_debit_per_contract: { type: "number" },
            max_loss_per_contract_group: { type: "number" },
            max_gain_per_contract_group: { type: "number" },
            breakevens: { type: "array", items: { type: "number" } },
            pop_estimate: { type: "number" },
            rationale: { type: "string", description: "≤25 words" },
            primary_risk: { type: "string", description: "≤25 words" },
            management: { type: "string", description: "≤25 words" },
          },
          required: [
            "name",
            "structure",
            "bias",
            "vol_view",
            "horizon_tag",
            "legs",
            "credit_or_debit",
            "estimated_credit_or_debit_per_contract",
            "max_loss_per_contract_group",
            "max_gain_per_contract_group",
            "breakevens",
            "pop_estimate",
            "rationale",
            "primary_risk",
            "management",
          ],
        },
      },
      caveats: { type: "string", description: "≤50 words" },
    },
    required: ["regime_summary", "primary_view", "strategies", "caveats"],
  },
} as const;

const SYSTEM_PROMPT = `You are an options strategist. Your job is to translate a market snapshot into a small set of concrete, executable trade ideas.

# Methodology (synthesis of public frameworks)

1. **Volatility view first.** Use IV/HV richness as the primary lever:
   - rich (IV/HV ≳ 1.25): favor **selling premium** — short put, short put spread, iron condor, short strangle (defined-risk preferred), iron butterfly, jade lizard.
   - fair (IV/HV between ~0.95 and ~1.25): mixed; prefer **directionally biased structures** (verticals, ratios) or **calendars/diagonals** that don't take a strong vol stance.
   - cheap (IV/HV ≲ 0.95): favor **buying premium** — long calls/puts, debit verticals, calendars, diagonals; avoid naked premium selling.

2. **Skew adjusts which side to lean on.**
   - steep_put (puts richer than calls by ≳ 6 vol points at 25Δ): sell put-side premium (e.g. cash-secured put, jade lizard, put ratio).
   - steep_call: sell call-side premium (rare; usually short-squeeze names).
   - flat: symmetric structures (iron condor, straddle, strangle).

3. **Direction.** Use put/call OI ratio + flow as a soft directional prior. Never override the vol view; modulate strike selection.

4. **Mechanics (TastyTrade-style defaults).**
   - Credit spreads / iron condors: short legs at ~16Δ, 30-45 DTE, take profit at 50% of credit, manage at 21 DTE.
   - Short strangles: 16Δ both sides, defined-risk version preferred (iron condor) for retail.
   - Calendars: same-strike short-dated short / longer-dated long; profit from front-month decay + back-month vega.
   - Verticals: 30-50Δ long leg, define max-loss equal to debit/spread-credit.
   - Always specify legs from the **quoted** contracts in the input — never invent strikes/expirations.

# Output rules

The response is constrained by a JSON schema (enforced server-side). Fill every required field. In addition to the schema:

- Return exactly **3 strategies**: one matched to the dominant regime view, one alternate (different structure or different horizon), and one defensive/hedging idea (e.g. collar, protective put, or risk-defined version of #1).
- All legs MUST reference **OCC symbols, strikes, and expirations that exist in the input snapshot** under \`horizons[].contracts\`. Do not invent.
- POP estimate: for short-premium trades, approximate 1 − |sum of short-leg deltas|; for debit verticals, |long-leg delta|.
- Keep every prose field tight (≤ 25 words). \`regime_summary\` ≤ 40 words. \`caveats\` ≤ 50 words.`;

// Verify the caller is a signed-in user by passing their token to InsForge's
// own session endpoint. Returns the user record if valid, null otherwise.
// /api/auth/sessions/current returns { user: {...} } for a real user token
// and { user: null } (or an error) for the anon key or invalid tokens.
async function fetchCurrentUser(
  baseUrl: string,
  token: string,
): Promise<{ id: string } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.user ?? null;
  } catch {
    return null;
  }
}

const ALLOWED_MODELS = new Set([
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4o-mini",
  "x-ai/grok-4.1-fast",
  "deepseek/deepseek-v3.2",
]);
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

function createPostHog(): PostHog | null {
  const apiKey = Deno.env.get("POSTHOG_API_KEY");
  if (!apiKey) return null;
  return new PostHog(apiKey, {
    host: Deno.env.get("POSTHOG_HOST") ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const posthog = createPostHog();
  let userId: string | undefined;

  try {
    // Only allow signed-in users. The anon key is rejected by InsForge's
    // session endpoint (returns user:null), so random anon-key holders can't
    // burn OpenRouter credits through this function.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = /^bearer\s+(.+)$/i.exec(authHeader)?.[1] ?? "";
    const baseUrl = Deno.env.get("INSFORGE_BASE_URL") ?? "";
    const user = bearer && baseUrl ? await fetchCurrentUser(baseUrl, bearer) : null;
    if (!user) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = user.id;
    posthog?.identify({
      distinctId: userId,
      properties: {
        $set: { id: userId },
      },
    });

    const body = await req.json();
    const { symbol, summary } = body ?? {};
    if (!symbol || !summary) {
      return new Response(JSON.stringify({ error: "symbol and summary required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    if (!openrouterKey) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requested = (body?.model ?? "").toString();
    const model = ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;

    posthog?.capture({
      distinctId: userId,
      event: "strategy_analysis_requested",
      properties: {
        symbol,
        model,
      },
    });

    const llmClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      timeout: 600_000,
    });

    const userMsg = `Underlying: ${symbol}\n\nSnapshot (JSON):\n${JSON.stringify(summary)}\n\nReturn the JSON object specified by the schema. Reference only contracts present in the snapshot.`;

    const callLLM = async () =>
      llmClient.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        temperature: 0.3,
        max_tokens: 2200,
        response_format: { type: "json_schema", json_schema: STRATEGY_SCHEMA },
      });

    // Retry once on 5xx / timeout / a 200 that parses to nothing (rare but
    // observed with some OpenRouter providers truncating mid-stream).
    const started = Date.now();
    let llm: any = null;
    let rawText = "";
    let parsed: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        llm = await callLLM();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt === 0 && /\b5\d\d\b|timeout|ECONNRESET|socket hang up/i.test(msg)) {
          continue;
        }
        throw e;
      }
      rawText = llm?.choices?.[0]?.message?.content ?? "";
      // With strict json_schema, content is already valid JSON.
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
      if (parsed !== null) break;
    }
    const tookMs = Date.now() - started;

    posthog?.capture({
      distinctId: userId,
      event: "strategy_analysis_completed",
      properties: {
        symbol,
        model: llm?.model ?? model,
        took_ms: tookMs,
        strategies_count: (parsed?.strategies as any[])?.length ?? 0,
        success: parsed !== null,
      },
    });
    await posthog?.shutdown();

    return new Response(
      JSON.stringify({
        symbol,
        analysis: parsed,
        raw: parsed ? undefined : rawText,
        model: llm?.model ?? model,
        tookMs,
        generatedAt: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    posthog?.captureException(err, userId);
    await posthog?.shutdown();
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
