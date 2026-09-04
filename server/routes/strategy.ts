// AI options strategist: the dashboard's regime snapshot in, three concrete
// trade proposals out. Signed-in users only, since every call spends
// OpenRouter credit.

import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { execute, query } from "../db.ts";
import { chatJson, openrouterClient } from "../jobs/shared/llm.ts";
import { createPostHog } from "../jobs/shared/posthog.ts";

export const strategyRouter = Router();
strategyRouter.use(requireAuth);

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

# Output rules

The response is constrained by a JSON schema (enforced server-side). Fill every required field. In addition to the schema:

- Return exactly **3 strategies**: one matched to the dominant regime view, one alternate (different structure or different horizon), and one defensive/hedging idea (e.g. collar, protective put, or risk-defined version of #1).
- All legs MUST reference **OCC symbols, strikes, and expirations that exist in the input snapshot** under \`horizons[].contracts\`. Do not invent.
- POP estimate: for short-premium trades, approximate 1 − |sum of short-leg deltas|; for debit verticals, |long-leg delta|.
- Keep every prose field tight (≤ 25 words). \`regime_summary\` ≤ 40 words. \`caveats\` ≤ 50 words.`;

const ALLOWED_MODELS = new Set([
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4o-mini",
  "x-ai/grok-4.1-fast",
  "deepseek/deepseek-v3.2",
]);
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_COLUMNS = "id, symbol, generated_at, analysis, model";

strategyRouter.get("/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol ?? "").toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return void res.status(400).json({ error: "invalid symbol" });
  res.json(
    await query(
      `SELECT ${ROW_COLUMNS} FROM strategy_analyses WHERE user_id = $1 AND symbol = $2
        ORDER BY generated_at DESC LIMIT 10`,
      [req.user!.id, symbol],
    ),
  );
});

strategyRouter.post("/", async (req, res) => {
  const symbol = String(req.body?.symbol ?? "").toUpperCase();
  const summary = req.body?.summary;
  if (!SYMBOL_RE.test(symbol) || !summary || typeof summary !== "object") {
    return void res.status(400).json({ error: "symbol and summary required" });
  }
  let llm;
  try {
    llm = openrouterClient();
  } catch (e: any) {
    return void res.status(503).json({ error: e.message });
  }
  const requested = String(req.body?.model ?? "");
  const model = ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
  const posthog = createPostHog();
  const userId = req.user!.id;
  posthog?.capture({ distinctId: userId, event: "strategy_analysis_requested", properties: { symbol, model } });

  const started = Date.now();
  try {
    const { parsed, rawText, model: usedModel } = await chatJson(llm, {
      model,
      system: SYSTEM_PROMPT,
      user: `Underlying: ${symbol}\n\nSnapshot (JSON):\n${JSON.stringify(summary)}\n\nReturn the JSON object specified by the schema. Reference only contracts present in the snapshot.`,
      schema: STRATEGY_SCHEMA,
      temperature: 0.3,
      maxTokens: 2200,
    });
    const tookMs = Date.now() - started;
    posthog?.capture({
      distinctId: userId,
      event: "strategy_analysis_completed",
      properties: { symbol, model: usedModel ?? model, took_ms: tookMs, strategies_count: parsed?.strategies?.length ?? 0, success: parsed !== null },
    });

    let row: unknown = null;
    if (parsed) {
      const rows = await query(
        `INSERT INTO strategy_analyses (user_id, symbol, snapshot, analysis, model)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING ${ROW_COLUMNS}`,
        [userId, symbol, JSON.stringify(summary), JSON.stringify(parsed), usedModel ?? model],
      );
      row = rows[0] ?? null;
    }
    res.json({ symbol, row, raw: parsed ? undefined : rawText, model: usedModel ?? model, tookMs });
  } finally {
    await posthog?.shutdown().catch(() => {});
  }
});

strategyRouter.delete("/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return void res.status(400).json({ error: "invalid id" });
  const n = await execute("DELETE FROM strategy_analyses WHERE id = $1 AND user_id = $2", [id, req.user!.id]);
  if (n === 0) return void res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});
