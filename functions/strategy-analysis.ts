// Edge function: options strategist.
// The frontend pre-computes a regime classification (IV-richness via IV/HV,
// skew bias, term structure, flow bias, premium posture) and a per-horizon
// snapshot of quoted contracts at standard delta points. We hand that to the
// LLM and ask for 3 strategy proposals as a strict JSON object.
//
// Methodology is a synthesis of public, widely-cited frameworks:
// - TastyTrade premium-selling rules (sell premium when vol is rich; 16Δ short
//   legs at 30-45 DTE; 50% profit target; manage at 21 DTE).
// - Option Alpha / Project Option strategy rubrics (regime → strategy fit).
// - Sheldon Natenberg's "Option Volatility & Pricing" framing (volatility view
//   first, direction second, structure third).

import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

# Required output

Return a single JSON object — no prose, no markdown, no code fences. Schema:

{
  "regime_summary": "1-2 sentences re-stating the regime in plain English, citing the IV/HV ratio, skew, and term structure.",
  "primary_view": { "volatility": "long_vol|short_vol|neutral_vol", "direction": "bullish|bearish|neutral" },
  "strategies": [
    {
      "name": "Iron Condor",
      "structure": "income_short_vol|income_short_vol_one_sided|debit_long_vol|debit_directional|calendar_diagonal|hedging_collar|naked_premium_sell|covered_yield",
      "bias": "bullish|bearish|neutral",
      "vol_view": "long_vol|short_vol|neutral_vol",
      "horizon_tag": "near_14d|primary_35d|long_90d",
      "legs": [
        {
          "action": "buy|sell",
          "right": "call|put",
          "symbol": "<OCC symbol from input>",
          "strike": 410,
          "expiration": "YYYY-MM-DD",
          "delta": -0.16,
          "qty": 1
        }
      ],
      "credit_or_debit": "credit|debit",
      "estimated_credit_or_debit_per_contract": 1.45,
      "max_loss_per_contract_group": 3.55,
      "max_gain_per_contract_group": 1.45,
      "breakevens": [408.55, 441.45],
      "pop_estimate": 0.68,
      "rationale": "1-2 sentence explanation linking the structure to the regime (vol richness, skew, term).",
      "primary_risk": "1 sentence on what kills this trade.",
      "management": "Specific rule: take-profit %, time-stop, adjustment trigger."
    }
  ],
  "caveats": "Single paragraph: position sizing (e.g. 1-3% of capital per trade), event/earnings risk, liquidity on far-OTM strikes, and that this is educational not financial advice."
}

# Constraints

- Return **3 strategies**: one matched to the dominant regime view, one alternate (different structure or different horizon), and one defensive/hedging idea (e.g. collar, protective put, or risk-defined version of #1).
- All legs MUST reference **OCC symbols, strikes, and expirations that exist in the input snapshot** under \`horizons[].contracts\`. Do not invent.
- POP estimate: for short-premium trades, approximate 1 − |sum of short-leg deltas|; for debit verticals, |long-leg delta|.
- Keep every prose field **≤ 25 words**. \`regime_summary\` ≤ 40 words. \`caveats\` ≤ 50 words. The JSON should fit comfortably under 1500 tokens.
- Output **only the JSON object** — no fences, no commentary, no thinking.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { symbol, summary } = body ?? {};
    if (!symbol || !summary) {
      return new Response(JSON.stringify({ error: "symbol and summary required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_BASE_URL"),
      anonKey: Deno.env.get("ANON_KEY"),
    });

    const userMsg = `Underlying: ${symbol}\n\nSnapshot (JSON):\n${JSON.stringify(summary)}\n\nReturn the JSON object specified by the schema. Keep prose fields tight (≤25 words each). Reference only contracts present in the snapshot.`;

    // Model selection: Sonnet-4.5 produces noticeably better methodology
    // adherence on this structured prompt; the caller can override via
    // body.model when speed is more important than reasoning depth.
    const requested = (body?.model ?? "").toString();
    const ALLOW = new Set([
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4o-mini",
      "x-ai/grok-4.1-fast",
      "deepseek/deepseek-v3.2",
    ]);
    const model = ALLOW.has(requested) ? requested : "anthropic/claude-sonnet-4.5";

    const started = Date.now();
    const result = await client.ai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      maxTokens: 2200,
    });
    const tookMs = Date.now() - started;

    const raw = result?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonObject(raw);

    return new Response(
      JSON.stringify({
        symbol,
        analysis: parsed,
        raw: parsed ? undefined : raw,
        model: result?.model,
        tookMs,
        generatedAt: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;
  // Strip code fences if the model used them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  // Find the first { and the matching closing } by brace-counting.
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
