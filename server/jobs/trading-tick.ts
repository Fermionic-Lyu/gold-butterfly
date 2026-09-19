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
import {
  currentValue,
  daysToExpiration,
  entryCost,
  expirationPassed,
  midOf,
  nearestByDelta,
  nearestByStrike,
  nearestExpiration,
  type Leg,
} from "./shared/options.ts";
import { isJevModel } from "./shared/typesafe.ts";
import { decideRangeWithJev } from "./jev-range.ts";
import { daysBetween, etTodayDate, nextFomcDate, tradingDaySkipReason } from "./shared/market-time.ts";
import { createPostHog } from "./shared/posthog.ts";
import { errMsg, mapWithConcurrency } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

type PostHogClient = ReturnType<typeof createPostHog>;

// 'pending'/'running' agent_runs older than this are dead dispatches and get retried.
const STALE_MS = 15 * 60 * 1000;
const CHAIN_FRESHNESS_MS = 10 * 60_000;

// Every DTE, expiry and lookback is measured from `asOf`; a non-null
// `chainDate` reads that archived session instead of the live chain.
export interface RunClock {
  runDate: string;
  asOf: Date;
  chainDate: string | null;
}

// A replay must sit after its own close, as the 18:10 ET live tick does, or that day's expirations read as unsettled.
export const clockFor = (runDate: string, replay: boolean): RunClock => ({
  runDate,
  asOf: replay ? new Date(`${runDate}T22:10:00Z`) : new Date(),
  chainDate: replay ? runDate : null,
});

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

export interface AgentRow {
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

interface NewsCatalyst {
  event: string;
  date: string | null;
  type: string;
  vol_impact: string;
}

interface NewsDigest {
  as_of_date: string;
  sentiment: string;
  sentiment_score: number | null;
  summary: string;
  key_points: string[];
  options_impact: string | null;
  upcoming_catalysts: NewsCatalyst[];
  article_count: number;
}

// A digest older than this describes a different news cycle; presenting it as
// today's would invent a catalyst that has already played out.
const DIGEST_MAX_AGE_DAYS = 4;

// Scheduled catalysts around the run date, so event-aware strategies can see
// how far they are from the next print or Fed decision.
interface EventContext {
  as_of: string;
  next_earnings: { date: string; days_until: number } | null;
  last_earnings: { date: string; days_since: number } | null;
  next_fomc: { date: string; days_until: number } | null;
  news_catalysts: (NewsCatalyst & { days_until: number | null })[];
}

// Where the stock has been: enough for a range or trend read without a chart.
interface PriceContext {
  closes: { date: string; close: number }[];
  high_20d: number;
  low_20d: number;
  range_20d_pct_of_spot: number | null;
  drift_10d_pct: number | null;
}

async function buildPriceContext(symbol: string, spot: number | null, runDate: string): Promise<PriceContext | null> {
  const rows = await query<{ date: string; close: number }>(
    "SELECT date, close FROM daily_bars WHERE symbol = $1 AND date <= $2 ORDER BY date DESC LIMIT 20",
    [symbol, runDate],
  ).catch(() => []);
  if (rows.length === 0) return null;
  const asc = rows.slice().reverse().map((r) => ({ date: String(r.date).slice(0, 10), close: Number(r.close) }));
  const closes = asc.map((r) => r.close);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const last10 = asc.slice(-10);
  const first = last10[0]?.close;
  const last = last10[last10.length - 1]?.close;
  return {
    closes: last10,
    high_20d: high,
    low_20d: low,
    range_20d_pct_of_spot: spot ? (high - low) / spot : null,
    drift_10d_pct: first && last ? (last - first) / first : null,
  };
}

async function buildEventContext(symbol: string, runDate: string): Promise<EventContext> {
  const [next, last] = await Promise.all([
    queryOne<{ date: string }>(
      "SELECT date FROM earnings_dates WHERE symbol = $1 AND date >= $2 ORDER BY date ASC LIMIT 1",
      [symbol, runDate],
    ).catch(() => null),
    queryOne<{ date: string }>(
      "SELECT date FROM earnings_dates WHERE symbol = $1 AND date < $2 ORDER BY date DESC LIMIT 1",
      [symbol, runDate],
    ).catch(() => null),
  ]);
  const fomc = nextFomcDate(runDate);
  return {
    as_of: runDate,
    next_earnings: next ? { date: next.date, days_until: daysBetween(runDate, next.date) } : null,
    last_earnings: last ? { date: last.date, days_since: daysBetween(last.date, runDate) } : null,
    next_fomc: fomc ? { date: fomc, days_until: daysBetween(runDate, fomc) } : null,
    news_catalysts: [],
  };
}

function withNewsCatalysts(events: EventContext, news: NewsDigest | null): EventContext {
  const raw = Array.isArray(news?.upcoming_catalysts) ? news.upcoming_catalysts : [];
  const news_catalysts = raw
    .filter((c) => c?.event && (!c.date || c.date >= events.as_of))
    .map((c) => ({ ...c, days_until: c.date ? daysBetween(events.as_of, c.date) : null }))
    .sort((a, b) => (a.days_until ?? 9999) - (b.days_until ?? 9999));
  return { ...events, news_catalysts };
}

function buildSymbolSnapshot(
  symbol: string,
  spot: number | null,
  contracts: ChainContract[],
  hv30: number | null,
  events: EventContext,
  priceHistory: PriceContext | null,
  asOf: Date,
) {
  const expirations = Array.from(new Set(contracts.map((c) => c.expiration))).sort();
  const horizons = [
    { tag: "near", days: 21 },
    { tag: "primary", days: 35 },
    { tag: "long", days: 49 },
  ]
    .map((h) => ({ ...h, expiration: nearestExpiration(expirations, h.days, asOf) }))
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
      days: Math.round(daysToExpiration(h.expiration!, asOf)),
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
    events,
    priceHistory,
    horizons: horizonContracts,
  };
}

// ---------- MTM ----------

function priceLeg(leg: Leg, spot: number | null, contracts: ChainContract[]): number | null {
  if (leg.instrument === "stock") return spot;
  const c = contracts.find((x) => x.symbol === leg.symbol);
  return c ? midOf(c) : null;
}

function markToMarketPosition(pos: PositionRow, spot: number | null, contracts: ChainContract[], asOf: Date) {
  const updatedLegs: Leg[] = pos.legs.map((leg) => {
    if (leg.expiration && expirationPassed(leg.expiration, asOf)) {
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
  asOf: Date;
}): string {
  const { symbol, preset, startingCapital, cash, totalEquity, openCount, thisSymbolOpen, recentClosed, marketSnapshot, ivRank, news, asOf } = args;
  const portfolio = {
    starting_capital: startingCapital,
    cash,
    total_equity: totalEquity,
    open_positions_count: openCount,
    open_positions_on_this_symbol: thisSymbolOpen.map((p) => ({
      id: p.id,
      strategy: p.strategy,
      opened_at: p.opened_at,
      dte: p.legs[0]?.expiration ? Math.round(daysToExpiration(p.legs[0].expiration, asOf)) : null,
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

  const newsBlock = news
    ? `${JSON.stringify(news, null, 2)}\n(digest is ${daysBetween(news.as_of_date, marketSnapshot.events.as_of)} day(s) old)`
    : "none available for this symbol today";

  return `Symbol under consideration: ${symbol}

PORTFOLIO STATE:
${JSON.stringify(portfolio, null, 2)}

RECENTLY CLOSED ON ${symbol} (last 5):
${JSON.stringify(recentClosed, null, 2)}

MARKET SNAPSHOT (end-of-day data from the most recent US close; \`events\` lists the next scheduled catalysts, \`priceHistory\` the last 10 closes and the 20-day range):
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

// Collateral scales with the short leg's own qty: entryCost sums leg values by
// leg qty, so using open_qty here would let 10 short contracts post margin for one.
function computeReservedCollateral(strategy: string, legs: Leg[]): number {
  const find = (instrument: Leg["instrument"], sign: 1 | -1) =>
    legs.find((l) => l.instrument === instrument && l.sign === sign);
  const m = (width: number, leg: Leg | undefined) => Math.max(0, width) * 100 * (leg?.qty ?? 1);
  switch (strategy) {
    case "cash_secured_put": {
      const put = find("put", -1);
      return put?.strike ? m(put.strike, put) : 0;
    }
    case "bull_put_credit_spread": {
      const shortPut = find("put", -1);
      const longPut = find("put", 1);
      if (!shortPut?.strike || !longPut?.strike) return 0;
      return m(shortPut.strike - longPut.strike, shortPut);
    }
    case "bear_call_credit_spread": {
      const shortCall = find("call", -1);
      const longCall = find("call", 1);
      if (!shortCall?.strike || !longCall?.strike) return 0;
      return m(longCall.strike - shortCall.strike, shortCall);
    }
    case "iron_condor":
    case "iron_butterfly": {
      const shortCall = find("call", -1);
      const longCall = find("call", 1);
      const shortPut = find("put", -1);
      const longPut = find("put", 1);
      if (!shortCall?.strike || !longCall?.strike || !shortPut?.strike || !longPut?.strike) return 0;
      const cw = longCall.strike - shortCall.strike;
      const pw = shortPut.strike - longPut.strike;
      return m(Math.max(cw, pw), shortCall);
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

// The legs a strategy name promises. A model that labels a naked short put
// "long_put" would otherwise book a credit with no collateral.
type LegShape = { instrument: Leg["instrument"]; sign: 1 | -1 };
type ShapeCheck = (m: Leg[]) => string | null;
const strikeOf = (l: Leg) => l.strike ?? NaN;
const sameExp = (a: Leg, b: Leg) => a.expiration === b.expiration;
const equalQty = (legs: Leg[]) => legs.every((l) => l.qty === legs[0].qty);

// Matched order is [wing, body, wing]; wings are 1x, the body 2x.
const butterflyCheck: ShapeCheck = ([a, body, b]) => {
  const [lo, hi] = strikeOf(a) < strikeOf(b) ? [a, b] : [b, a];
  if (!(strikeOf(lo) < strikeOf(body) && strikeOf(body) < strikeOf(hi))) return "butterfly body strike must sit between the wings";
  if (Math.abs(strikeOf(body) - strikeOf(lo) - (strikeOf(hi) - strikeOf(body))) > 1e-6) return "butterfly wings must be equidistant from the body";
  if (!sameExp(lo, body) || !sameExp(body, hi)) return "butterfly legs must share an expiration";
  if (lo.qty !== hi.qty || body.qty !== 2 * lo.qty) return "butterfly needs 1x wings and a 2x body";
  return null;
};

// `qty` overrides the default rule that every leg carries the same quantity.
const STRATEGY_SHAPES: Record<string, { legs: LegShape[]; check?: ShapeCheck; qty?: ShapeCheck }> = {
  long_stock: { legs: [{ instrument: "stock", sign: 1 }] },
  long_call: { legs: [{ instrument: "call", sign: 1 }] },
  long_put: { legs: [{ instrument: "put", sign: 1 }] },
  cash_secured_put: { legs: [{ instrument: "put", sign: -1 }] },
  covered_call: {
    legs: [{ instrument: "stock", sign: 1 }, { instrument: "call", sign: -1 }],
    qty: ([stock, call]) => (stock.qty !== call.qty * 100 ? "covered call needs 100 shares per short call" : null),
  },
  iron_butterfly: {
    legs: [
      { instrument: "put", sign: 1 }, { instrument: "put", sign: -1 },
      { instrument: "call", sign: -1 }, { instrument: "call", sign: 1 },
    ],
    check: ([lp, sp, sc, lc]) =>
      strikeOf(sp) !== strikeOf(sc)
        ? "iron butterfly short put and short call must share the body strike"
        : !(strikeOf(lp) < strikeOf(sp) && strikeOf(lc) > strikeOf(sc))
          ? "iron butterfly wings must bracket the body strike"
          : ![sp, sc, lc].every((l) => sameExp(lp, l)) ? "iron butterfly legs must share an expiration" : null,
  },
  long_call_butterfly: {
    legs: [{ instrument: "call", sign: 1 }, { instrument: "call", sign: -1 }, { instrument: "call", sign: 1 }],
    check: butterflyCheck,
    qty: () => null,
  },
  long_put_butterfly: {
    legs: [{ instrument: "put", sign: 1 }, { instrument: "put", sign: -1 }, { instrument: "put", sign: 1 }],
    check: butterflyCheck,
    qty: () => null,
  },
  long_straddle: {
    legs: [{ instrument: "call", sign: 1 }, { instrument: "put", sign: 1 }],
    check: ([c, p]) => (strikeOf(c) !== strikeOf(p) ? "straddle legs must share a strike" : !sameExp(c, p) ? "straddle legs must share an expiration" : null),
  },
  long_strangle: {
    legs: [{ instrument: "call", sign: 1 }, { instrument: "put", sign: 1 }],
    check: ([c, p]) => (!(strikeOf(c) > strikeOf(p)) ? "strangle call strike must be above the put strike" : !sameExp(c, p) ? "strangle legs must share an expiration" : null),
  },
  bull_call_debit_spread: {
    legs: [{ instrument: "call", sign: 1 }, { instrument: "call", sign: -1 }],
    check: ([lo, sh]) => (!(strikeOf(lo) < strikeOf(sh)) ? "bull call spread: long strike must be below the short strike" : !sameExp(lo, sh) ? "vertical legs must share an expiration" : null),
  },
  bear_put_debit_spread: {
    legs: [{ instrument: "put", sign: 1 }, { instrument: "put", sign: -1 }],
    check: ([lo, sh]) => (!(strikeOf(lo) > strikeOf(sh)) ? "bear put spread: long strike must be above the short strike" : !sameExp(lo, sh) ? "vertical legs must share an expiration" : null),
  },
  bull_put_credit_spread: {
    legs: [{ instrument: "put", sign: -1 }, { instrument: "put", sign: 1 }],
    check: ([sh, lo]) => (!(strikeOf(sh) > strikeOf(lo)) ? "bull put spread: short strike must be above the long strike" : !sameExp(sh, lo) ? "vertical legs must share an expiration" : null),
  },
  bear_call_credit_spread: {
    legs: [{ instrument: "call", sign: -1 }, { instrument: "call", sign: 1 }],
    check: ([sh, lo]) => (!(strikeOf(sh) < strikeOf(lo)) ? "bear call spread: short strike must be below the long strike" : !sameExp(sh, lo) ? "vertical legs must share an expiration" : null),
  },
  iron_condor: {
    legs: [
      { instrument: "put", sign: 1 }, { instrument: "put", sign: -1 },
      { instrument: "call", sign: -1 }, { instrument: "call", sign: 1 },
    ],
    check: ([lp, sp, sc, lc]) =>
      !(strikeOf(lp) < strikeOf(sp) && strikeOf(sp) < strikeOf(sc) && strikeOf(sc) < strikeOf(lc))
        ? "iron condor strikes must be ordered long put < short put < short call < long call"
        : ![sp, sc, lc].every((l) => sameExp(lp, l)) ? "iron condor legs must share an expiration" : null,
  },
  calendar_spread: {
    legs: [],
    check: (legs) => {
      if (legs.length !== 2 || legs[0].instrument === "stock" || legs[0].instrument !== legs[1].instrument) return "calendar must be two options of the same type";
      const short = legs.find((l) => l.sign === -1);
      const long = legs.find((l) => l.sign === 1);
      if (!short || !long) return "calendar needs one short and one long leg";
      if (strikeOf(short) !== strikeOf(long)) return "calendar legs must share a strike";
      if (!(String(short.expiration) < String(long.expiration))) return "calendar short leg must expire before the long leg";
      if (!equalQty(legs)) return "calendar legs must carry the same qty";
      return null;
    },
  },
};

function validateLegShape(strategy: string, legs: Leg[]): string | null {
  const shape = STRATEGY_SHAPES[strategy];
  if (!shape) return `no leg template for strategy ${strategy}`;
  for (const l of legs) {
    if (l.sign !== 1 && l.sign !== -1) return `leg ${l.symbol}: sign must be 1 or -1`;
    if (!Number.isInteger(l.qty) || l.qty < 1) return `leg ${l.symbol}: qty must be a positive integer`;
    if (l.instrument !== "stock" && (typeof l.strike !== "number" || !l.expiration)) return `leg ${l.symbol}: options need strike and expiration`;
  }
  if (shape.legs.length > 0) {
    if (legs.length !== shape.legs.length) return `${strategy} needs ${shape.legs.length} leg(s), got ${legs.length}`;
    const pool = [...legs];
    const matched: Leg[] = [];
    for (const want of shape.legs) {
      const i = pool.findIndex((l) => l.instrument === want.instrument && l.sign === want.sign);
      if (i < 0) return `${strategy} requires a ${want.sign > 0 ? "long" : "short"} ${want.instrument} leg`;
      matched.push(pool.splice(i, 1)[0]);
    }
    const qtyError = shape.qty ? shape.qty(matched) : equalQty(matched) ? null : `${strategy} legs must carry the same qty`;
    return qtyError ?? shape.check?.(matched) ?? null;
  }
  return shape.check?.(legs) ?? null;
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
  asOf: Date,
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
  const shapeError = validateLegShape(proposal.strategy, proposal.legs);
  if (shapeError) return fail(shapeError);
  for (const leg of proposal.legs) {
    if (leg.expiration) {
      const dte = daysToExpiration(leg.expiration, asOf);
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
  const reserved = computeReservedCollateral(proposal.strategy, proposal.legs);
  const cost = entryCost(proposal.legs, reserved);
  // A credit larger than its collateral, or a debit structure priced at a
  // credit, is a quoting artifact, not a free trade.
  if (!(cost > 0)) {
    return fail(`net entry cost ${cost.toFixed(0)} is not positive — credit exceeds collateral or quotes are stale`, reserved, cost);
  }
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
  return { spot: u.spot == null ? null : Number(u.spot), contracts: toContracts(quotes) };
}

function toContracts(quotes: Record<string, unknown>[]): ChainContract[] {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return quotes.map((q) => ({
    symbol: q.occ_symbol as string,
    expiration: String(q.expiration).slice(0, 10),
    strike: Number(q.strike),
    type: q.type as ChainContract["type"],
    bid: num(q.bid),
    ask: num(q.ask),
    delta: num(q.delta),
    iv: num(q.iv),
  }));
}

// One archived session exactly as snapshot-chain-eod stored it.
async function fetchChainFromHistory(symbol: string, date: string) {
  const u = await queryOne<{ spot: number | null }>(
    "SELECT spot FROM chain_underlyings_history WHERE symbol = $1 AND date = $2",
    [symbol, date],
  );
  if (!u || u.spot === null) return null;
  const quotes = await query(
    `SELECT occ_symbol, expiration, strike, type, bid, ask, delta, iv
       FROM chain_quotes_history WHERE underlying = $1 AND date = $2
      ORDER BY expiration ASC, strike ASC`,
    [symbol, date],
  );
  if (quotes.length === 0) return null;
  return { spot: Number(u.spot), contracts: toContracts(quotes) };
}

// instruments.hv30 holds only the latest value, so a replay recomputes the
// trailing-31-bar figure the way recompute_hv30 does.
async function hv30AsOf(symbol: string, date: string): Promise<number | null> {
  const row = await queryOne<{ hv: number | null }>(
    `WITH ranked AS (
       SELECT close,
              LAG(close) OVER (ORDER BY date) AS prev_close,
              ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
         FROM daily_bars WHERE symbol = $1 AND date <= $2
     )
     SELECT (STDDEV_SAMP(LN(close / prev_close)) * SQRT(252))::float8 AS hv
       FROM ranked
      WHERE rn <= 31 AND prev_close IS NOT NULL AND prev_close > 0
     HAVING COUNT(*) >= 10`,
    [symbol, date],
  ).catch(() => null);
  return row?.hv == null ? null : Number(row.hv);
}

async function analyzeSymbol(
  symbol: string,
  agent: AgentRow,
  allOpen: PositionRow[],
  llm: OpenAI,
  clock: RunClock,
): Promise<AnalyzeResult> {
  const { runDate, asOf } = clock;
  try {
    const eventsP = buildEventContext(symbol, runDate);
    const recentClosedP = query(
      `SELECT strategy, opened_at, closed_at, realized_pnl, entry_cost
         FROM positions
        WHERE agent_id = $1 AND symbol = $2 AND status IN ('closed','expired')
        ORDER BY closed_at DESC LIMIT 5`,
      [agent.id, symbol],
    );
    const cutoff = new Date(asOf);
    cutoff.setUTCDate(cutoff.getUTCDate() - 365);
    const ivSnapsP = query<{ atm_iv: number | null }>(
      "SELECT atm_iv FROM iv_snapshots WHERE symbol = $1 AND captured_at >= $2 AND captured_at <= $3 LIMIT 5000",
      [symbol, cutoff.toISOString(), asOf.toISOString()],
    );
    const newsP = queryOne<NewsDigest>(
      `SELECT as_of_date, sentiment, sentiment_score, summary, key_points, options_impact,
              upcoming_catalysts, article_count
         FROM news_analyses
        WHERE symbol = $1 AND as_of_date >= $2::date - $3::int
        ORDER BY as_of_date DESC LIMIT 1`,
      [symbol, runDate, DIGEST_MAX_AGE_DAYS],
    ).catch(() => null);

    let spot: number | null = null;
    let contracts: ChainContract[] = [];
    let hv30: number | null = null;
    if (clock.chainDate) {
      // Falling back to live quotes here would price a past decision at today's market.
      const archived = await fetchChainFromHistory(symbol, clock.chainDate);
      if (!archived) return { kind: "error", symbol, error: `no archived chain for ${clock.chainDate}` };
      spot = archived.spot;
      contracts = archived.contracts;
      hv30 = await hv30AsOf(symbol, runDate);
    } else {
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
    }

    const [recentClosed, ivSnapsRaw, newsRaw, scheduled, priceHistory] = await Promise.all([
      recentClosedP,
      ivSnapsP,
      newsP,
      eventsP,
      buildPriceContext(symbol, spot, runDate),
    ]);
    const news = newsRaw ? { ...newsRaw, as_of_date: String(newsRaw.as_of_date).slice(0, 10) } : null;
    const events = withNewsCatalysts(scheduled, news);

    const thisSymOpenRaw = allOpen.filter((p) => p.symbol === symbol);
    const mtmResults = thisSymOpenRaw.map((pos) => ({ pos, result: markToMarketPosition(pos, spot, contracts, asOf) }));
    const thisSymOpen: PositionRow[] = mtmResults.map(({ pos, result }) => ({
      ...pos,
      current_value: result.current_value ?? pos.current_value,
      legs: result.legs,
    }));

    const marketSnapshot = buildSymbolSnapshot(symbol, spot, contracts, hv30, events, priceHistory, asOf);

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
      asOf,
    });

    let decision: any = null;
    let rawText = "";
    if (isJevModel(agent.model)) {
      ({ decision, rawText } = await decideRangeWithJev({
        symbol,
        runDate,
        asOf,
        agent,
        spot,
        contracts,
        atmIV: marketSnapshot.atmIV,
        hv30,
        ivHvRatio: marketSnapshot.ivHvRatio,
        ivRank: ivRankInfo?.rank ?? null,
        priceHistory,
        events,
        news,
        openCount: allOpen.length,
        openPositions: thisSymOpen,
      }));
    } else {
      ({ parsed: decision, rawText } = await chatJson(llm, {
        model: agent.model,
        system: `${DAILY_CADENCE_ADDENDUM}\n${agent.system_prompt}`,
        user: userPrompt,
        schema: DECISION_SCHEMA,
        temperature: 0.3,
        maxTokens: 4048,
      }));
    }

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

async function processAgent(agent: AgentRow, clock: RunClock, dryRun: boolean, posthog: PostHogClient) {
  const { runDate, asOf } = clock;
  const llm = openrouterClient();
  const allOpen = await query<PositionRow>(
    "SELECT * FROM positions WHERE agent_id = $1 AND status = 'open' ORDER BY opened_at ASC LIMIT 200",
    [agent.id],
  );

  // Every symbol sees the same starting state; ranking in Phase B keeps
  // analysis order from biasing which opens win.
  const phaseA = await Promise.all(agent.watched_symbols.map((s) => analyzeSymbol(s, agent, allOpen, llm, clock)));

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
        pos.legs.length > 0 && pos.legs.every((l) => l.expiration && expirationPassed(l.expiration, asOf));
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
      // Every option leg must be a contract we actually quoted; otherwise the
      // fill price is whatever the model made up.
      const unquoted = refilledLegs.filter((l) => l.instrument !== "stock" && !r.contracts.some((c) => c.symbol === l.symbol));
      if (unquoted.length > 0) {
        const note = `legs not in the current chain: ${unquoted.map((l) => l.symbol).join(", ")}`;
        decide(r.symbol, "skip_invalid", confidence, reasoning, null, snap, decision, note);
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid", reason: note });
        continue;
      }
      const qty = proposal.qty || 1;
      const pre = preValidateOpen(
        { ...proposal, legs: refilledLegs, qty },
        agent.preset,
        agent,
        snap.ivHvRatio,
        r.ivRankInfo?.rank ?? null,
        asOf,
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
    ...(clock.chainDate ? { as_of: asOf.toISOString() } : {}),
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

export async function runAgentWithStatus(agent: AgentRow, clock: RunClock, dryRun: boolean, posthog: PostHogClient) {
  const runDate = clock.runDate;
  const startedAt = new Date().toISOString();
  if (!dryRun) await upsertAgentRun(runDate, agent.slug, { status: "running", started_at: startedAt }).catch(() => {});
  try {
    const result = await processAgent(agent, clock, dryRun, posthog);
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
  const clock = clockFor(runDate, false);
  const startedAt = Date.now();

  try {
    if (explicitSlug) {
      const agent = await queryOne<AgentRow>("SELECT * FROM agents WHERE slug = $1 AND active = true", [explicitSlug]);
      if (!agent) throw new Error(`no active agent with slug ${explicitSlug}`);
      const result = await runAgentWithStatus(agent, clock, dryRun, posthog);
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
      runAgentWithStatus(a, clock, dryRun, posthog),
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
