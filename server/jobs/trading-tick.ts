// Daily paper-trading agent runner. Once per trading day after the close, each
// active agent runs two phases:
//   Phase A: every watched symbol analyzed in parallel against the cached
//            chain; the agent's LLM returns one decision per symbol.
//   Phase B: expirations + MTM + closes applied deterministically; `open`
//            proposals ranked by confidence and greedily committed under the
//            cap / cash / concentration limits, surplus logged as
//            skip_outranked. Everything lands in one apply_agent_tick call.
//
//   args: { force?: boolean, slug?: string, run_date?: "YYYY-MM-DD", dry_run?: boolean }

import type OpenAI from "openai";
import { env } from "../env.ts";
import { pool, query, queryOne } from "../db.ts";
import {
  fetchChainLive,
  fetchHv30Live,
  fetchSpot,
  requireAlpaca,
  type ChainContractLite as ChainContract,
} from "./shared/alpaca.ts";
import { chatJson, openrouterClient } from "./shared/llm.ts";
import { etTodayDate, tradingDaySkipReason } from "./shared/market-time.ts";
import { createPostHog } from "./shared/posthog.ts";
import { errMsg, mapWithConcurrency } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

type PostHogClient = ReturnType<typeof createPostHog>;

// 'pending'/'running' agent_runs older than this are dead dispatches and get retried.
const STALE_MS = 15 * 60 * 1000;
const CHAIN_FRESHNESS_MS = 10 * 60_000;

// ---------- types ----------

interface AgentPreset {
  max_concurrent_positions: number;
  max_position_size_pct: number;
  max_concentration_per_symbol_pct: number;
  min_confidence_to_trade: number;
  min_dte: number;
  max_dte: number;
  allowed_strategies: string[];
  vol_view_required?: "rich_or_fair" | "rich" | "cheap_or_fair" | "any";
  profit_target_pct?: number;
  manage_at_dte?: number;
}

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  focus: string;
  model: string;
  system_prompt: string;
  preset: AgentPreset;
  watched_symbols: string[];
  starting_capital: number;
  cash: number;
  active: boolean;
}

interface Leg {
  sign: 1 | -1;
  qty: number;
  instrument: "stock" | "call" | "put";
  symbol: string;
  strike?: number;
  expiration?: string;
  fill_price: number;
  current_price?: number;
}

interface PositionRow {
  id: string;
  agent_id: string;
  symbol: string;
  strategy: string;
  legs: Leg[];
  reserved_collateral: number;
  entry_cost: number;
  current_value: number | null;
  status: "open" | "closed" | "expired";
  opened_at: Date;
  closed_at: Date | null;
}

interface NewsDigest {
  as_of_date: string;
  sentiment: string;
  sentiment_score: number | null;
  summary: string;
  key_points: string[];
  options_impact: string | null;
  article_count: number;
}

// ---------- pure helpers ----------

const multiplier = (instrument: Leg["instrument"]) => (instrument === "stock" ? 1 : 100);
const legValue = (leg: Leg, price: number) => leg.sign * leg.qty * price * multiplier(leg.instrument);
const entryCost = (legs: Leg[], collateral: number) =>
  legs.reduce((sum, l) => sum + legValue(l, l.fill_price), 0) + collateral;
const currentValue = (legs: Leg[], collateral: number) =>
  legs.reduce((sum, l) => sum + legValue(l, l.current_price ?? l.fill_price), 0) + collateral;

function midOf(c: ChainContract): number | null {
  if (c.bid !== null && c.ask !== null && c.bid >= 0 && c.ask >= 0) {
    if (c.ask === 0) return null;
    return (c.bid + c.ask) / 2;
  }
  return null;
}

function daysToExpiration(exp: string, now = new Date()): number {
  return Math.max((new Date(exp + "T16:00:00Z").getTime() - now.getTime()) / 86_400_000, 0);
}

const expirationPassed = (exp: string, now = new Date()) => new Date(exp + "T20:00:00Z") < now;

function nearestByDelta(contracts: ChainContract[], target: number): ChainContract | null {
  let best: ChainContract | null = null;
  let bestDiff = Infinity;
  for (const c of contracts) {
    if (c.delta === null) continue;
    const diff = Math.abs(c.delta - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function nearestByStrike(contracts: ChainContract[], spot: number): ChainContract | null {
  let best: ChainContract | null = null;
  let bestDiff = Infinity;
  for (const c of contracts) {
    const diff = Math.abs(c.strike - spot);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

function nearestExpiration(expirations: string[], targetDays: number): string | null {
  if (expirations.length === 0) return null;
  let best = expirations[0];
  let bestDiff = Infinity;
  for (const e of expirations) {
    const diff = Math.abs(daysToExpiration(e) - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  return best;
}

function buildSymbolSnapshot(symbol: string, spot: number | null, contracts: ChainContract[], hv30: number | null) {
  const expirations = Array.from(new Set(contracts.map((c) => c.expiration))).sort();
  const horizons = [
    { tag: "near", days: 21 },
    { tag: "primary", days: 35 },
    { tag: "long", days: 49 },
  ]
    .map((h) => ({ ...h, expiration: nearestExpiration(expirations, h.days) }))
    .filter((h) => h.expiration);

  const horizonContracts = horizons.map((h) => {
    const calls = contracts.filter((c) => c.type === "call" && c.expiration === h.expiration);
    const puts = contracts.filter((c) => c.type === "put" && c.expiration === h.expiration);
    const tags: { tag: string; c: ChainContract | null }[] = [
      { tag: "call_30d", c: nearestByDelta(calls, 0.3) },
      { tag: "call_20d", c: nearestByDelta(calls, 0.2) },
      { tag: "call_16d", c: nearestByDelta(calls, 0.16) },
      { tag: "call_10d", c: nearestByDelta(calls, 0.1) },
      { tag: "put_30d", c: nearestByDelta(puts, -0.3) },
      { tag: "put_20d", c: nearestByDelta(puts, -0.2) },
      { tag: "put_16d", c: nearestByDelta(puts, -0.16) },
      { tag: "put_10d", c: nearestByDelta(puts, -0.1) },
    ];
    return {
      tag: h.tag,
      expiration: h.expiration,
      days: Math.round(daysToExpiration(h.expiration!)),
      contracts: tags
        .filter((t) => t.c !== null)
        .map((t) => ({
          tag: t.tag,
          symbol: t.c!.symbol,
          type: t.c!.type,
          strike: t.c!.strike,
          delta: t.c!.delta,
          iv: t.c!.iv,
          bid: t.c!.bid,
          ask: t.c!.ask,
          mid: midOf(t.c!),
        })),
    };
  });

  let atmIV: number | null = null;
  const primary = horizons.find((h) => h.tag === "primary")?.expiration ?? null;
  if (spot !== null && primary) {
    const c = nearestByStrike(contracts.filter((c) => c.type === "call" && c.expiration === primary), spot);
    const p = nearestByStrike(contracts.filter((c) => c.type === "put" && c.expiration === primary), spot);
    const civ = c?.iv ?? null;
    const piv = p?.iv ?? null;
    atmIV = civ !== null && piv !== null ? (civ + piv) / 2 : (civ ?? piv);
  }

  return {
    symbol,
    spot,
    atmIV,
    hv30,
    ivHvRatio: atmIV !== null && hv30 ? atmIV / hv30 : null,
    horizons: horizonContracts,
  };
}

// ---------- MTM ----------

function priceLeg(leg: Leg, spot: number | null, contracts: ChainContract[]): number | null {
  if (leg.instrument === "stock") return spot;
  const c = contracts.find((x) => x.symbol === leg.symbol);
  return c ? midOf(c) : null;
}

function markToMarketPosition(pos: PositionRow, spot: number | null, contracts: ChainContract[]) {
  const now = new Date();
  const updatedLegs: Leg[] = pos.legs.map((leg) => {
    if (leg.expiration && expirationPassed(leg.expiration, now)) {
      const intrinsic =
        spot !== null && leg.strike !== undefined
          ? leg.instrument === "call"
            ? Math.max(0, spot - leg.strike)
            : Math.max(0, leg.strike - spot)
          : 0;
      return { ...leg, current_price: intrinsic };
    }
    const px = priceLeg(leg, spot, contracts);
    return { ...leg, current_price: px ?? leg.current_price ?? leg.fill_price };
  });
  const allPriced = updatedLegs.every((l) => typeof l.current_price === "number");
  return {
    current_value: allPriced ? currentValue(updatedLegs, pos.reserved_collateral) : null,
    legs: updatedLegs,
  };
}

// ---------- LLM contract ----------

// Flat shape: nullable nested objects and per-field enums are rejected or
// violated by some providers' structured-output implementations.
const DECISION_SCHEMA = {
  name: "agent_decision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "open | close | hold" },
      confidence: { type: "number" },
      reasoning: { type: "string", description: "≤50 words" },
      open_strategy: {
        type: ["string", "null"],
        description: "Required when action is open: one of allowed_strategies. Null otherwise.",
      },
      open_qty: {
        type: ["number", "null"],
        description: "Required when action is open: integer ≥ 1. Null otherwise.",
      },
      open_legs: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sign: { type: "number", description: "1 for long, -1 for short" },
            qty: { type: "number" },
            instrument: { type: "string", description: "stock | call | put" },
            symbol: { type: "string", description: "OCC symbol for options, ticker for stock" },
            strike: { type: ["number", "null"] },
            expiration: { type: ["string", "null"], description: "YYYY-MM-DD for options, null for stock" },
            fill_price: { type: "number" },
          },
          required: ["sign", "qty", "instrument", "symbol", "strike", "expiration", "fill_price"],
        },
        description: "Required when action is open. Null otherwise.",
      },
      close_position_id: {
        type: ["string", "null"],
        description: "Required when action is close: UUID of YOUR open position on this symbol. Null otherwise.",
      },
      close_reason: {
        type: ["string", "null"],
        description: "Required when action is close: ≤30 words. Null otherwise.",
      },
    },
    required: [
      "action",
      "confidence",
      "reasoning",
      "open_strategy",
      "open_qty",
      "open_legs",
      "close_position_id",
      "close_reason",
    ],
  },
};

const DAILY_CADENCE_ADDENDUM = [
  "TRADING CADENCE — IMPORTANT:",
  "You evaluate this symbol exactly once per US trading day, after the market close.",
  "You will not be called again on this symbol until tomorrow's close.",
  "There is no intraday reaction available to you. Size, structure, and stop-management",
  "must assume daily-only review until the position is closed.",
  "",
].join("\n");

function buildUserPrompt(args: {
  symbol: string;
  preset: AgentPreset;
  startingCapital: number;
  cash: number;
  totalEquity: number;
  openCount: number;
  thisSymbolOpen: PositionRow[];
  recentClosed: any[];
  marketSnapshot: any;
  ivRank: IvRankInfo | null;
  news: NewsDigest | null;
}): string {
  const { symbol, preset, startingCapital, cash, totalEquity, openCount, thisSymbolOpen, recentClosed, marketSnapshot, ivRank, news } = args;
  const portfolio = {
    starting_capital: startingCapital,
    cash,
    total_equity: totalEquity,
    open_positions_count: openCount,
    open_positions_on_this_symbol: thisSymbolOpen.map((p) => ({
      id: p.id,
      strategy: p.strategy,
      opened_at: p.opened_at,
      dte: p.legs[0]?.expiration ? Math.round(daysToExpiration(p.legs[0].expiration)) : null,
      legs: p.legs.map((l) => ({
        sign: l.sign,
        qty: l.qty,
        instrument: l.instrument,
        symbol: l.symbol,
        strike: l.strike,
        expiration: l.expiration,
        fill_price: l.fill_price,
        current_price: l.current_price,
      })),
      entry_cost: p.entry_cost,
      current_value: p.current_value,
      unrealized_pnl: p.current_value !== null ? p.current_value - p.entry_cost : null,
      unrealized_pnl_pct:
        p.current_value !== null && p.entry_cost > 0 ? (p.current_value - p.entry_cost) / p.entry_cost : null,
    })),
  };

  const constraints = {
    max_concurrent_positions: preset.max_concurrent_positions,
    max_position_size_usd: startingCapital * preset.max_position_size_pct,
    max_concentration_per_symbol_usd: startingCapital * preset.max_concentration_per_symbol_pct,
    min_confidence_to_trade: preset.min_confidence_to_trade,
    dte_window: [preset.min_dte, preset.max_dte],
    allowed_strategies: preset.allowed_strategies,
    vol_view_required: preset.vol_view_required ?? "any",
    profit_target_pct: preset.profit_target_pct ?? null,
    manage_at_dte: preset.manage_at_dte ?? null,
  };

  const newsBlock = news ? JSON.stringify(news, null, 2) : "none available for this symbol today";

  return `Symbol under consideration: ${symbol}

PORTFOLIO STATE:
${JSON.stringify(portfolio, null, 2)}

RECENTLY CLOSED ON ${symbol} (last 5):
${JSON.stringify(recentClosed, null, 2)}

MARKET SNAPSHOT (end-of-day data from the most recent US close):
${JSON.stringify({ ...marketSnapshot, ivRank }, null, 2)}

RECENT NEWS DIGEST (AI summary of today's headlines — sentiment, catalysts, and likely options impact):
${newsBlock}

CONSTRAINTS:
${JSON.stringify(constraints, null, 2)}

This is your once-per-day decision for ${symbol}, made after the US close. Pick exactly one action.
Weigh the news digest alongside the market snapshot — a strong catalyst or sentiment shift can justify acting or staying out, but the structured market data remains your primary signal.

OUTPUT RULES:
- "action" is "open", "close", or "hold". "confidence" is between 0 and 1.
- When "action" is "open": fill open_strategy (from allowed_strategies), open_qty (≥1), and open_legs (each leg's OCC symbol must come from marketSnapshot.horizons[].contracts). Set close_position_id and close_reason to null.
- When "action" is "close": set close_position_id to one of the UUIDs in open_positions_on_this_symbol, and close_reason. Set open_strategy, open_qty, open_legs to null.
- When "action" is "hold": set all five open_*/close_* fields to null.
- Leg fields: sign is +1 (long) or -1 (short); instrument is "stock", "call", or "put"; fill_price is the mid quote from the snapshot for that contract.
- The response shape is enforced by structured outputs — focus on quality, not formatting.`;
}

// ---------- validation ----------

interface ProposedOpen {
  strategy: string;
  qty: number;
  legs: Leg[];
}

function computeReservedCollateral(strategy: string, legs: Leg[], qty: number): number {
  const m = (n: number) => n * 100 * qty;
  const find = (instrument: Leg["instrument"], sign: 1 | -1) =>
    legs.find((l) => l.instrument === instrument && l.sign === sign);
  switch (strategy) {
    case "cash_secured_put": {
      const put = find("put", -1);
      return put?.strike ? m(put.strike) : 0;
    }
    case "covered_call":
      return 0;
    case "bull_put_credit_spread": {
      const shortPut = find("put", -1);
      const longPut = find("put", 1);
      if (!shortPut?.strike || !longPut?.strike) return 0;
      return m(Math.max(0, shortPut.strike - longPut.strike));
    }
    case "bear_call_credit_spread": {
      const shortCall = find("call", -1);
      const longCall = find("call", 1);
      if (!shortCall?.strike || !longCall?.strike) return 0;
      return m(Math.max(0, longCall.strike - shortCall.strike));
    }
    case "iron_condor": {
      const shortCall = find("call", -1);
      const longCall = find("call", 1);
      const shortPut = find("put", -1);
      const longPut = find("put", 1);
      if (!shortCall?.strike || !longCall?.strike || !shortPut?.strike || !longPut?.strike) return 0;
      const cw = Math.max(0, longCall.strike - shortCall.strike);
      const pw = Math.max(0, shortPut.strike - longPut.strike);
      return m(Math.max(cw, pw));
    }
    default:
      return 0;
  }
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
  reservedCollateral: number;
  computedEntryCost: number;
}

// Order-independent checks only: anything that fails here is intrinsically
// infeasible. Cap, runtime cash and concentration are order-dependent and are
// decided in the ranked commit loop.
function preValidateOpen(
  proposal: ProposedOpen,
  preset: AgentPreset,
  agent: AgentRow,
  ivHvRatio: number | null,
  ivRank: number | null,
): ValidationResult {
  const fail = (reason: string, reserved = 0, cost = 0): ValidationResult => ({
    ok: false,
    reason,
    reservedCollateral: reserved,
    computedEntryCost: cost,
  });
  if (!preset.allowed_strategies.includes(proposal.strategy)) {
    return fail(`strategy ${proposal.strategy} not in allowed list`);
  }
  for (const leg of proposal.legs) {
    if (leg.expiration) {
      const dte = daysToExpiration(leg.expiration);
      if (dte < preset.min_dte || dte > preset.max_dte) {
        return fail(`leg DTE ${Math.round(dte)} outside [${preset.min_dte},${preset.max_dte}]`);
      }
    }
  }
  const ivHvStr = ivHvRatio?.toFixed(2) ?? "?";
  const ivRankStr = ivRank !== null ? Math.round(ivRank * 100) + "%" : "?";
  if (preset.vol_view_required === "rich_or_fair") {
    const richOk = ivHvRatio !== null && ivHvRatio >= 1.1;
    const rankOk = ivRank !== null && ivRank >= 0.3;
    if (!richOk && !rankOk) {
      return fail(`vol regime cheap (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only sell premium when rich`);
    }
  } else if (preset.vol_view_required === "cheap_or_fair") {
    const cheapOk = ivHvRatio !== null && ivHvRatio <= 0.95;
    const rankOk = ivRank !== null && ivRank <= 0.25;
    if (!cheapOk && !rankOk) {
      return fail(`vol regime rich/fair (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only buy premium when cheap`);
    }
  }
  const reserved = computeReservedCollateral(proposal.strategy, proposal.legs, proposal.qty || 1);
  const cost = entryCost(proposal.legs, reserved);
  const sizeCap = agent.starting_capital * preset.max_position_size_pct;
  if (cost > sizeCap) {
    return fail(`position size ${cost.toFixed(0)} exceeds cap ${sizeCap.toFixed(0)}`, reserved, cost);
  }
  return { ok: true, reservedCollateral: reserved, computedEntryCost: cost };
}

// ---------- Phase A ----------

interface IvRankInfo {
  rank: number | null;
  samples: number;
  min: number | null;
  max: number | null;
}

interface AnalyzeOk {
  kind: "ok";
  symbol: string;
  spot: number;
  contracts: ChainContract[];
  thisSymOpen: PositionRow[];
  mtmResults: { pos: PositionRow; result: ReturnType<typeof markToMarketPosition> }[];
  marketSnapshot: ReturnType<typeof buildSymbolSnapshot>;
  ivRankInfo: IvRankInfo | null;
  recentClosed: any[];
  decision: any | null;
  rawText: string;
}
type AnalyzeResult = AnalyzeOk | { kind: "error"; symbol: string; error: string };

// Fresh chain from the DB cache (filled by fetch-chains); null when missing or
// older than 10 minutes so the caller falls back to live Alpaca.
async function fetchChainFromCache(symbol: string) {
  const u = await queryOne<{ spot: number | null; fetched_at: Date }>(
    "SELECT spot, fetched_at FROM chain_underlyings WHERE symbol = $1",
    [symbol],
  );
  if (!u) return null;
  const age = Date.now() - new Date(u.fetched_at).getTime();
  if (!Number.isFinite(age) || age > CHAIN_FRESHNESS_MS) return null;
  const quotes = await query(
    `SELECT occ_symbol, expiration, strike, type, bid, ask, delta, iv
       FROM chain_quotes WHERE underlying = $1
      ORDER BY expiration ASC, strike ASC`,
    [symbol],
  );
  const contracts: ChainContract[] = quotes.map((q) => ({
    symbol: q.occ_symbol,
    expiration: String(q.expiration).slice(0, 10),
    strike: Number(q.strike),
    type: q.type,
    bid: q.bid == null ? null : Number(q.bid),
    ask: q.ask == null ? null : Number(q.ask),
    delta: q.delta == null ? null : Number(q.delta),
    iv: q.iv == null ? null : Number(q.iv),
  }));
  return { spot: u.spot == null ? null : Number(u.spot), contracts };
}

async function analyzeSymbol(
  symbol: string,
  agent: AgentRow,
  allOpen: PositionRow[],
  llm: OpenAI,
): Promise<AnalyzeResult> {
  try {
    const recentClosedP = query(
      `SELECT strategy, opened_at, closed_at, realized_pnl, entry_cost
         FROM positions
        WHERE agent_id = $1 AND symbol = $2 AND status IN ('closed','expired')
        ORDER BY closed_at DESC LIMIT 5`,
      [agent.id, symbol],
    );
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 365);
    const ivSnapsP = query<{ atm_iv: number | null }>(
      "SELECT atm_iv FROM iv_snapshots WHERE symbol = $1 AND captured_at >= $2 LIMIT 5000",
      [symbol, cutoff.toISOString()],
    );
    const newsP = queryOne<NewsDigest>(
      `SELECT as_of_date, sentiment, sentiment_score, summary, key_points, options_impact, article_count
         FROM news_analyses WHERE symbol = $1 ORDER BY as_of_date DESC LIMIT 1`,
      [symbol],
    ).catch(() => null);

    let spot: number | null = null;
    let contracts: ChainContract[] = [];
    let hv30: number | null = null;
    const cached = await fetchChainFromCache(symbol).catch(() => null);
    if (cached && cached.spot !== null) {
      spot = cached.spot;
      contracts = cached.contracts;
      const inst = await queryOne<{ hv30: number | null }>("SELECT hv30 FROM instruments WHERE symbol = $1", [symbol]).catch(
        () => null,
      );
      hv30 = inst?.hv30 ?? null;
    } else {
      spot = await fetchSpot(symbol);
      if (spot === null) return { kind: "error", symbol, error: "no spot" };
      [contracts, hv30] = await Promise.all([fetchChainLive(symbol, spot), fetchHv30Live(symbol)]);
    }

    const [recentClosed, ivSnapsRaw, news] = await Promise.all([recentClosedP, ivSnapsP, newsP]);

    const thisSymOpenRaw = allOpen.filter((p) => p.symbol === symbol);
    const mtmResults = thisSymOpenRaw.map((pos) => ({ pos, result: markToMarketPosition(pos, spot, contracts) }));
    const thisSymOpen: PositionRow[] = mtmResults.map(({ pos, result }) => ({
      ...pos,
      current_value: result.current_value ?? pos.current_value,
      legs: result.legs,
    }));

    const marketSnapshot = buildSymbolSnapshot(symbol, spot, contracts, hv30);

    let ivRankInfo: IvRankInfo | null = null;
    if (marketSnapshot.atmIV !== null) {
      const ivs = ivSnapsRaw.map((s) => Number(s.atm_iv)).filter(Number.isFinite);
      if (ivs.length >= 5) {
        const min = Math.min(...ivs);
        const max = Math.max(...ivs);
        const rank = max > min ? (marketSnapshot.atmIV - min) / (max - min) : null;
        ivRankInfo = { rank, samples: ivs.length, min, max };
      } else if (ivs.length > 0) {
        ivRankInfo = { rank: null, samples: ivs.length, min: null, max: null };
      }
    }

    const otherOpen = allOpen.filter((p) => p.symbol !== symbol);
    const equityFromPositions =
      thisSymOpen.reduce((s, p) => s + Number(p.current_value ?? p.entry_cost ?? 0), 0) +
      otherOpen.reduce((s, p) => s + Number(p.current_value ?? p.entry_cost ?? 0), 0);
    const totalEquity = Number(agent.cash) + equityFromPositions;

    const userPrompt = buildUserPrompt({
      symbol,
      preset: agent.preset,
      startingCapital: agent.starting_capital,
      cash: Number(agent.cash),
      totalEquity,
      openCount: allOpen.length,
      thisSymbolOpen: thisSymOpen,
      recentClosed,
      marketSnapshot,
      ivRank: ivRankInfo,
      news,
    });

    const { parsed: decision, rawText } = await chatJson(llm, {
      model: agent.model,
      system: `${DAILY_CADENCE_ADDENDUM}\n${agent.system_prompt}`,
      user: userPrompt,
      schema: DECISION_SCHEMA,
      temperature: 0.3,
      maxTokens: 4048,
    });

    return {
      kind: "ok",
      symbol,
      spot,
      contracts,
      thisSymOpen,
      mtmResults,
      marketSnapshot,
      ivRankInfo,
      recentClosed,
      decision,
      rawText,
    };
  } catch (e) {
    return { kind: "error", symbol, error: errMsg(e, 500) };
  }
}

// ---------- Phase B ----------

interface DecisionOut {
  symbol: string;
  action: string;
  confidence: number | null;
  reasoning: string;
  position_id: string | null;
  snapshot: unknown;
  raw_response: unknown;
  validation_notes: string | null;
}

async function processAgent(agent: AgentRow, runDate: string, dryRun: boolean, posthog: PostHogClient) {
  const llm = openrouterClient();
  const allOpen = await query<PositionRow>(
    "SELECT * FROM positions WHERE agent_id = $1 AND status = 'open' ORDER BY opened_at ASC LIMIT 200",
    [agent.id],
  );

  // Every symbol sees the same starting state; ranking in Phase B keeps
  // analysis order from biasing which opens win.
  const phaseA = await Promise.all(agent.watched_symbols.map((s) => analyzeSymbol(s, agent, allOpen, llm)));

  let cash = Number(agent.cash);
  const symbolBlobs: any[] = [];
  const expires: any[] = [];
  const mtmUpdates: any[] = [];
  const closes: any[] = [];
  const opens: any[] = [];
  const decisions: DecisionOut[] = [];

  const finalOpen = new Map<string, { entry_cost: number; current_value: number }>();
  for (const p of allOpen) {
    finalOpen.set(p.id, { entry_cost: Number(p.entry_cost), current_value: Number(p.current_value ?? p.entry_cost) });
  }
  const symbolOpenCost = new Map<string, number>();
  for (const p of allOpen) {
    symbolOpenCost.set(p.symbol, (symbolOpenCost.get(p.symbol) ?? 0) + Number(p.entry_cost));
  }

  interface OpenCandidate {
    r: AnalyzeOk;
    proposal: ProposedOpen;
    confidence: number;
    reasoning: string;
    reservedCollateral: number;
    cost: number;
  }
  const openCandidates: OpenCandidate[] = [];

  const decide = (
    symbol: string,
    action: string,
    confidence: number | null,
    reasoning: string,
    position_id: string | null,
    snapshot: unknown,
    raw_response: unknown,
    validation_notes: string | null,
  ) => decisions.push({ symbol, action, confidence, reasoning, position_id, snapshot, raw_response, validation_notes });

  for (const r of phaseA) {
    if (r.kind === "error") {
      decide(r.symbol, "error", null, r.error.slice(0, 500), null, null, null, null);
      symbolBlobs.push({ symbol: r.symbol, error: r.error.slice(0, 200) });
      continue;
    }

    for (const { pos, result } of r.mtmResults) {
      const allExpired =
        pos.legs.length > 0 && pos.legs.every((l) => l.expiration && expirationPassed(l.expiration));
      if (allExpired && result.current_value !== null) {
        const cv = result.current_value;
        expires.push({
          position_id: pos.id,
          exit_proceeds: cv,
          realized_pnl: cv - pos.entry_cost,
          current_value: cv,
          legs: result.legs,
        });
        cash += cv;
        finalOpen.delete(pos.id);
        symbolOpenCost.set(pos.symbol, (symbolOpenCost.get(pos.symbol) ?? 0) - Number(pos.entry_cost));
      } else if (result.current_value !== null) {
        mtmUpdates.push({ position_id: pos.id, current_value: result.current_value, legs: result.legs });
        const fp = finalOpen.get(pos.id);
        if (fp) fp.current_value = result.current_value;
      }
    }

    const remainingOpen = r.thisSymOpen.filter((p) => finalOpen.has(p.id));
    const decision = r.decision;
    const snap = r.marketSnapshot;

    if (!decision) {
      decide(r.symbol, "error", null, "Failed to parse JSON from model.", null, snap, { raw: r.rawText }, null);
      symbolBlobs.push({ symbol: r.symbol, action: "error" });
      continue;
    }

    const action = String(decision.action ?? "hold");
    const confidence = typeof decision.confidence === "number" ? decision.confidence : null;
    const reasoning = String(decision.reasoning ?? "").slice(0, 1000);

    if (action === "hold") {
      decide(r.symbol, "hold", confidence, reasoning, null, snap, decision, null);
      symbolBlobs.push({ symbol: r.symbol, action: "hold" });
      continue;
    }

    if (action === "close") {
      const positionId = decision.close_position_id;
      const target = remainingOpen.find((p) => p.id === positionId);
      if (!target) {
        decide(r.symbol, "skip_invalid", confidence, reasoning, null, snap, decision,
          `position_id ${positionId} not found among open ${r.symbol} positions`);
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      if (target.current_value === null) {
        decide(r.symbol, "skip_invalid", confidence, reasoning, target.id, snap, decision, "MTM unavailable; cannot close");
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      const realized = target.current_value - target.entry_cost;
      closes.push({ position_id: target.id, exit_proceeds: target.current_value, realized_pnl: realized });
      cash += target.current_value;
      finalOpen.delete(target.id);
      symbolOpenCost.set(target.symbol, (symbolOpenCost.get(target.symbol) ?? 0) - Number(target.entry_cost));
      decide(r.symbol, "close", confidence, reasoning, target.id, snap, decision, null);
      posthog?.capture({
        distinctId: agent.slug,
        event: "agent_position_closed",
        properties: { agent_slug: agent.slug, agent_focus: agent.focus, symbol: r.symbol, realized_pnl: realized, run_date: runDate },
      });
      symbolBlobs.push({ symbol: r.symbol, action: "close", realized });
      continue;
    }

    if (action === "open") {
      const proposal: ProposedOpen | null =
        decision.open_strategy && Array.isArray(decision.open_legs)
          ? { strategy: String(decision.open_strategy), qty: Number(decision.open_qty ?? 1), legs: decision.open_legs as Leg[] }
          : null;
      if (!proposal) {
        decide(r.symbol, "skip_invalid", confidence, reasoning, null, snap, decision, "missing open_strategy or open_legs");
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      if (confidence === null || confidence < agent.preset.min_confidence_to_trade) {
        decide(r.symbol, "skip_low_confidence", confidence, reasoning, null, snap, decision,
          `confidence ${confidence} < floor ${agent.preset.min_confidence_to_trade}`);
        symbolBlobs.push({ symbol: r.symbol, action: "skip_low_confidence" });
        continue;
      }
      // Fill prices come from our snapshot, never from the model.
      const refilledLegs: Leg[] = proposal.legs.map((l) => {
        if (l.instrument === "stock") {
          return { ...l, sign: l.sign as 1 | -1, fill_price: r.spot, current_price: r.spot };
        }
        const c = r.contracts.find((x) => x.symbol === l.symbol);
        const m = c ? midOf(c) : null;
        return { ...l, sign: l.sign as 1 | -1, fill_price: m ?? l.fill_price, current_price: m ?? l.fill_price };
      });
      const qty = proposal.qty || 1;
      const pre = preValidateOpen(
        { ...proposal, legs: refilledLegs, qty },
        agent.preset,
        agent,
        snap.ivHvRatio,
        r.ivRankInfo?.rank ?? null,
      );
      if (!pre.ok) {
        decide(r.symbol, "skip_invalid", confidence, reasoning, null, snap, decision, pre.reason ?? null);
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid", reason: pre.reason });
        continue;
      }
      openCandidates.push({
        r,
        proposal: { ...proposal, legs: refilledLegs, qty },
        confidence,
        reasoning,
        reservedCollateral: pre.reservedCollateral,
        cost: pre.computedEntryCost,
      });
      continue;
    }

    decide(r.symbol, "skip_invalid", confidence, reasoning, null, snap, decision, `unknown action: ${action}`);
    symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
  }

  // Ranked commit: highest-confidence opens take the scarce slots first.
  openCandidates.sort((a, b) => b.confidence - a.confidence);
  const cap = agent.preset.max_concurrent_positions;
  const symCap = agent.starting_capital * agent.preset.max_concentration_per_symbol_pct;
  for (const cand of openCandidates) {
    const reasons: string[] = [];
    if (finalOpen.size >= cap) reasons.push(`at max concurrent positions (${cap})`);
    if (cand.cost > cash) {
      reasons.push(`insufficient cash after prior commits: needs ${cand.cost.toFixed(0)}, have ${cash.toFixed(0)}`);
    }
    const symRunning = symbolOpenCost.get(cand.r.symbol) ?? 0;
    if (symRunning + cand.cost > symCap) {
      reasons.push(`concentration on ${cand.r.symbol} would be ${(symRunning + cand.cost).toFixed(0)}, cap ${symCap.toFixed(0)}`);
    }
    if (reasons.length > 0) {
      const note = `outranked by higher-confidence opens: ${reasons.join("; ")}`;
      decide(cand.r.symbol, "skip_outranked", cand.confidence, cand.reasoning, null, cand.r.marketSnapshot, cand.r.decision, note);
      symbolBlobs.push({ symbol: cand.r.symbol, action: "skip_outranked", reason: note });
      continue;
    }
    opens.push({
      symbol: cand.r.symbol,
      strategy: cand.proposal.strategy,
      legs: cand.proposal.legs,
      reserved_collateral: cand.reservedCollateral,
      entry_cost: cand.cost,
      rationale: cand.reasoning,
      _decision: {
        action: "open",
        confidence: cand.confidence,
        reasoning: cand.reasoning,
        snapshot: cand.r.marketSnapshot,
        raw_response: cand.r.decision,
        validation_notes: null,
      },
    });
    cash -= cand.cost;
    finalOpen.set(`new-${opens.length}`, { entry_cost: cand.cost, current_value: cand.cost });
    symbolOpenCost.set(cand.r.symbol, symRunning + cand.cost);
    posthog?.capture({
      distinctId: agent.slug,
      event: "agent_position_opened",
      properties: {
        agent_slug: agent.slug,
        agent_focus: agent.focus,
        symbol: cand.r.symbol,
        strategy: cand.proposal.strategy,
        entry_cost: cand.cost,
        confidence: cand.confidence,
        run_date: runDate,
      },
    });
    symbolBlobs.push({ symbol: cand.r.symbol, action: "open", strategy: cand.proposal.strategy, entry_cost: cand.cost });
  }

  const positionsMtm = Array.from(finalOpen.values()).reduce((s, p) => s + (p.current_value ?? p.entry_cost), 0);
  const totalEquity = cash + positionsMtm;

  const payload = {
    agent_id: agent.id,
    run_date: runDate,
    final_cash: cash,
    expires,
    mtm_updates: mtmUpdates,
    closes,
    opens,
    decisions,
    equity: { cash, positions_mtm: positionsMtm, total_equity: totalEquity, open_positions: finalOpen.size },
  };

  const applied = dryRun
    ? { dry_run: true }
    : (await queryOne<{ result: unknown }>("SELECT apply_agent_tick($1::jsonb) AS result", [JSON.stringify(payload)]))?.result;

  return {
    agent: agent.slug,
    cash,
    positions_mtm: positionsMtm,
    total_equity: totalEquity,
    open_positions: finalOpen.size,
    applied,
    actions: symbolBlobs,
    payload: dryRun ? payload : undefined,
  };
}

// ---------- status tracking ----------

async function upsertAgentRun(runDate: string, slug: string, patch: Record<string, unknown>) {
  const cols = Object.keys(patch);
  const params = [runDate, slug, ...cols.map((c) => patch[c])];
  await pool.query(
    `INSERT INTO agent_runs (run_date, agent_slug, ${cols.join(",")})
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(",")})
     ON CONFLICT (run_date, agent_slug) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`,
    params,
  );
}

async function runAgentWithStatus(agent: AgentRow, runDate: string, dryRun: boolean, posthog: PostHogClient) {
  const startedAt = new Date().toISOString();
  if (!dryRun) await upsertAgentRun(runDate, agent.slug, { status: "running", started_at: startedAt }).catch(() => {});
  try {
    const result = await processAgent(agent, runDate, dryRun, posthog);
    if (!dryRun) {
      await upsertAgentRun(runDate, agent.slug, {
        status: "done",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: null,
      }).catch(() => {});
    }
    return { slug: agent.slug, ok: true, result };
  } catch (e) {
    const error = errMsg(e, 500);
    if (!dryRun) {
      await upsertAgentRun(runDate, agent.slug, {
        status: "error",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error,
      }).catch(() => {});
    }
    return { slug: agent.slug, ok: false, error };
  }
}

// ---------- entry ----------

export async function tradingTick(args: JobArgs) {
  requireAlpaca();
  openrouterClient();
  const posthog = createPostHog();
  const force = args.force === true;
  const dryRun = args.dry_run === true;
  const explicitSlug = typeof args.slug === "string" && args.slug ? args.slug : null;
  const runDate = typeof args.run_date === "string" && args.run_date ? args.run_date : etTodayDate();
  const startedAt = Date.now();

  try {
    if (explicitSlug) {
      const agent = await queryOne<AgentRow>("SELECT * FROM agents WHERE slug = $1 AND active = true", [explicitSlug]);
      if (!agent) throw new Error(`no active agent with slug ${explicitSlug}`);
      const result = await runAgentWithStatus(agent, runDate, dryRun, posthog);
      return { tickedAt: new Date().toISOString(), runDate, mode: "single", dryRun, result };
    }

    if (!force) {
      const reason = await tradingDaySkipReason(runDate);
      if (reason) return { skipped: true, reason, runDate };
    }

    const allAgents = await query<AgentRow>("SELECT * FROM agents WHERE active = true ORDER BY created_at");
    if (allAgents.length === 0) return { skipped: true, reason: "no active agents", runDate };

    const todayRuns = await query<{ agent_slug: string; status: string; dispatched_at: Date | null; started_at: Date | null }>(
      "SELECT agent_slug, status, dispatched_at, started_at FROM agent_runs WHERE run_date = $1",
      [runDate],
    );
    const now = Date.now();
    const skip = new Set<string>();
    for (const r of todayRuns) {
      if (r.status === "done") skip.add(r.agent_slug);
      else if (r.status === "running" && now - (r.started_at ? new Date(r.started_at).getTime() : 0) < STALE_MS) skip.add(r.agent_slug);
      else if (r.status === "pending" && now - (r.dispatched_at ? new Date(r.dispatched_at).getTime() : 0) < STALE_MS) skip.add(r.agent_slug);
    }
    const toProcess = allAgents.filter((a) => !skip.has(a.slug));
    const skipped = allAgents.length - toProcess.length;
    if (toProcess.length === 0) {
      return { skipped: true, reason: "all agents already done/in-flight for today", runDate, totalAgents: allAgents.length };
    }

    if (!dryRun) {
      const dispatchedAt = new Date().toISOString();
      await Promise.all(
        toProcess.map((a) => upsertAgentRun(runDate, a.slug, { status: "pending", dispatched_at: dispatchedAt }).catch(() => {})),
      );
    }

    const results = await mapWithConcurrency(toProcess, env.agentConcurrency, (a) =>
      runAgentWithStatus(a, runDate, dryRun, posthog),
    );
    const succeeded = results.filter((r) => r.ok).length;
    const elapsedMs = Date.now() - startedAt;

    posthog?.capture({
      distinctId: "system",
      event: "agent_tick_completed",
      properties: {
        mode: "batch",
        run_date: runDate,
        total_agents: allAgents.length,
        skipped,
        dispatched: toProcess.length,
        succeeded,
        failed: results.length - succeeded,
        elapsed_ms: elapsedMs,
      },
    });

    return {
      tickedAt: new Date().toISOString(),
      runDate,
      mode: "batch",
      dryRun,
      elapsedMs,
      totalAgents: allAgents.length,
      skipped,
      dispatched: toProcess.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  } finally {
    await posthog?.shutdown().catch(() => {});
  }
}
