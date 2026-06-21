// Edge function: daily-rebalance agent runner.
//
// Cron fires once per US trading weekday after the close. Reads every
// active agent and processes them inside ONE function invocation. Per
// agent we run two phases:
//   Phase A: in parallel, analyze each watched symbol against its cached
//            chain and ask the agent's configured LLM for a decision.
//            Each call sees the same starting state — there's no
//            knowledge of what other symbols decide.
//   Phase B: handle MTM + closes deterministically; then rank all
//            `open` proposals by agent-reported confidence and greedy-
//            commit until cap / cash / per-symbol concentration is
//            exhausted. The surplus is recorded as `skip_outranked` so
//            the audit log shows which signals lost the race.
//
// We previously tried a coordinator → worker HTTP fan-out. InsForge's
// edge platform blocks recursive same-deployment HTTP with HTTP 508
// (LOOP_DETECTED), so the workers never ran. This single-function design
// is what the platform actually supports.
//
// Note on walltime: the scheduler's HTTP client returns 504 around ~200s
// even though the function itself has no hard runtime limit
// (observed). Per-agent walltime is dominated by the slowest symbol's
// LLM call (Phase A runs them in parallel), so 4 agents at concurrency=1
// finish well under that window.
//
// Body modes:
//   {}                              → batch mode: handle all not-yet-done
//                                      active agents (cron path).
//   {"slug": "<agent_slug>"}        → single-slug debug mode: handle just
//                                      that agent. For manual testing.
//   {"force": true}                  → bypass the trading-day gate.
//
// Auth: X-Schedule-Secret header matching SCHEDULE_SECRET.

import OpenAI from "npm:openai@^4";
import { PostHog } from "npm:posthog-node";

const ALPACA_DATA = "https://data.alpaca.markets";

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

// Bounded concurrency for the batch path. Within each agent, the watched
// symbols are analyzed in parallel — that already produces a ~28-read
// PostgREST burst (7 symbols × ~4 reads each: chain_quotes,
// chain_underlyings, recent closed positions, IV snapshots) plus ~7
// simultaneous LLM calls. We saw ECONNRESETs when multiple agents
// stacked that burst together, so we keep this at 1.
//
// Total walltime is the sum of per-agent walltimes (~30s for the
// gemini-bound agents, much less for others). Four agents finish in
// under 90s — well inside the scheduler's ~200s HTTP-client window.
//
// Past ~6-8 agents, switch to per-agent schedules (single-slug mode)
// rather than raising this further.
const BATCH_CONCURRENCY = 1;

// 'pending' agent_runs rows older than this are treated as failed
// dispatches (the worker never started) and retried by the next cron run.
const STALE_PENDING_MS = 15 * 60 * 1000;

// ---------- types ----------

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
  opened_at: string;
  closed_at: string | null;
}

interface ChainContract {
  symbol: string; // OCC
  expiration: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  delta: number | null;
  iv: number | null;
}

interface Env {
  alpacaKey: string;
  alpacaSecret: string;
  baseUrl: string;
  apiKey: string;
  openrouterKey: string;
}

// ---------- pure helpers ----------

function multiplier(instrument: Leg["instrument"]) {
  return instrument === "stock" ? 1 : 100;
}

function legValue(leg: Leg, price: number): number {
  return leg.sign * leg.qty * price * multiplier(leg.instrument);
}

function entryCost(legs: Leg[], collateral: number): number {
  return legs.reduce((sum, l) => sum + legValue(l, l.fill_price), 0) + collateral;
}

function currentValue(legs: Leg[], collateral: number): number {
  return (
    legs.reduce((sum, l) => sum + legValue(l, l.current_price ?? l.fill_price), 0) +
    collateral
  );
}

function midOf(c: ChainContract): number | null {
  if (c.bid !== null && c.ask !== null && c.bid >= 0 && c.ask >= 0) {
    if (c.ask === 0) return null;
    return (c.bid + c.ask) / 2;
  }
  return null;
}

function daysToExpiration(exp: string, now = new Date()): number {
  return Math.max(
    (new Date(exp + "T16:00:00Z").getTime() - now.getTime()) / 86_400_000,
    0,
  );
}

// Today's date in US/Eastern, DST-aware. Used as the run_date key on
// agent_runs / decisions so all in a tick share one trading-day stamp.
function etTodayDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

// ---------- Alpaca ----------

// Retries on 429 AND 5xx — transient upstream Alpaca errors otherwise
// cost a full tick of data across all NDX-100 symbols. Caught us on
// 2026-05-12T14:34Z–15:33Z, so 5xx retry is now standard.
async function alpacaFetch(url: string, key: string, secret: string, attempt = 0): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
  });
  const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (transient && attempt < 3) {
    const delay = 600 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    return alpacaFetch(url, key, secret, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function parseOcc(occ: string): { type: "call" | "put"; strike: number; expiration: string } | null {
  const m = occ.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const ymd = m[1];
  return {
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: m[2] === "C" ? "call" : "put",
    strike: parseInt(m[3], 10) / 1000,
  };
}

async function fetchSpot(symbol: string, key: string, secret: string): Promise<number | null> {
  try {
    const t = await alpacaFetch(`${ALPACA_DATA}/v2/stocks/${symbol}/trades/latest?feed=iex`, key, secret);
    if (typeof t?.trade?.p === "number") return t.trade.p;
  } catch {}
  try {
    const q = await alpacaFetch(`${ALPACA_DATA}/v2/stocks/${symbol}/quotes/latest?feed=iex`, key, secret);
    if (typeof q?.quote?.bp === "number" && typeof q?.quote?.ap === "number") {
      return (q.quote.bp + q.quote.ap) / 2;
    }
  } catch {}
  return null;
}

async function fetchChain(symbol: string, spot: number, key: string, secret: string): Promise<ChainContract[]> {
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  const band = spot * 0.4;
  const url = new URL(`${ALPACA_DATA}/v1beta1/options/snapshots/${symbol}`);
  url.searchParams.set("limit", "1000");
  url.searchParams.set("strike_price_gte", Math.max(0, spot - band).toFixed(2));
  url.searchParams.set("strike_price_lte", (spot + band).toFixed(2));
  url.searchParams.set("expiration_date_lte", horizon.toISOString().slice(0, 10));

  const all: Record<string, any> = {};
  let pageToken: string | undefined;
  let pages = 0;
  do {
    if (pageToken) url.searchParams.set("page_token", pageToken);
    else url.searchParams.delete("page_token");
    const data = await alpacaFetch(url.toString(), key, secret);
    if (data?.snapshots) Object.assign(all, data.snapshots);
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < 8);

  const contracts: ChainContract[] = [];
  for (const [occ, snap] of Object.entries<any>(all)) {
    const p = parseOcc(occ);
    if (!p) continue;
    const q = snap?.latestQuote;
    contracts.push({
      symbol: occ,
      expiration: p.expiration,
      strike: p.strike,
      type: p.type,
      bid: q?.bp ?? null,
      ask: q?.ap ?? null,
      delta: snap?.greeks?.delta ?? null,
      iv: snap?.impliedVolatility ?? null,
    });
  }
  return contracts;
}

function hv30FromCloses(closes: number[]): number | null {
  if (closes.length < 11) return null;
  const slice = closes.slice(-31);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Live Alpaca fallback for symbols not in daily_bars (i.e. outside NDX-100).
async function fetchHv30(symbol: string, key: string, secret: string): Promise<number | null> {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 60);
  const url =
    `${ALPACA_DATA}/v2/stocks/${symbol}/bars?timeframe=1Day` +
    `&start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}` +
    `&limit=60&adjustment=split&feed=iex`;
  try {
    const data = await alpacaFetch(url, key, secret);
    const closes = (data?.bars ?? []).map((b: any) => b.c).filter((x: any) => Number.isFinite(x));
    return hv30FromCloses(closes);
  } catch {
    return null;
  }
}

// ---------- snapshot summarization ----------

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
    if (civ !== null && piv !== null) atmIV = (civ + piv) / 2;
    else atmIV = civ ?? piv;
  }

  return { symbol, spot, atmIV, hv30, ivHvRatio: atmIV !== null && hv30 ? atmIV / hv30 : null, horizons: horizonContracts };
}

// ---------- DB helpers ----------

function dbHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Prefer: "return=representation",
  };
}

async function dbGet(baseUrl: string, apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/records/${path}`, { headers: dbHeaders(apiKey) });
  if (!res.ok) throw new Error(`db get ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function dbUpsert(baseUrl: string, apiKey: string, table: string, rows: any[]): Promise<void> {
  const res = await fetch(`${baseUrl}/api/database/records/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`db upsert ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Call a PostgreSQL function via PostgREST's RPC endpoint. The function
// body runs in a single Postgres transaction, so any error inside it
// rolls back ALL of its writes — which is exactly the atomicity guarantee
// we need for the worker's Phase B.
async function dbRpc(
  baseUrl: string,
  apiKey: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`db rpc ${fn} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

// ---------- MTM ----------

function priceLeg(leg: Leg, spot: number | null, contracts: ChainContract[]): number | null {
  if (leg.instrument === "stock") return spot;
  const c = contracts.find((x) => x.symbol === leg.symbol);
  if (!c) return null;
  return midOf(c);
}

function markToMarketPosition(
  pos: PositionRow,
  spot: number | null,
  contracts: ChainContract[],
): { current_value: number | null; legs: Leg[]; expiredLegs: Leg[] } {
  const now = new Date();
  const expiredLegs: Leg[] = [];
  const updatedLegs: Leg[] = pos.legs.map((leg) => {
    if (leg.expiration && new Date(leg.expiration + "T20:00:00Z") < now) {
      const intrinsic =
        spot !== null && leg.strike !== undefined
          ? leg.instrument === "call"
            ? Math.max(0, spot - leg.strike)
            : Math.max(0, leg.strike - spot)
          : 0;
      const updated = { ...leg, current_price: intrinsic };
      expiredLegs.push(updated);
      return updated;
    }
    const px = priceLeg(leg, spot, contracts);
    return { ...leg, current_price: px ?? leg.current_price ?? leg.fill_price };
  });
  const allPriced = updatedLegs.every((l) => typeof l.current_price === "number");
  const cv = allPriced ? currentValue(updatedLegs, pos.reserved_collateral) : null;
  return { current_value: cv, legs: updatedLegs, expiredLegs };
}

// ---------- LLM ----------

// JSON Schema enforced via OpenRouter's structured-outputs (response_format
// with strict:true). Flat shape — no nullable nested objects, no per-field
// enums beyond `action`. Earlier we used nullable nested `open`/`close`
// objects (["object","null"]) and enum-constrained `strategy`, which:
//   - Anthropic's structured-outputs implementation rejected outright (400)
//   - Gemini's implementation accepted but routinely violated, then errored
//   - OpenAI handled but didn't add value over a flat shape
// Fields irrelevant to the chosen action are simply null. Strategy/sign/
// instrument are validated semantically in code, not at the schema layer.
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
        description:
          "Required when action is open: one of allowed_strategies. Null otherwise.",
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
            symbol: {
              type: "string",
              description: "OCC symbol for options, ticker for stock",
            },
            strike: { type: ["number", "null"] },
            expiration: {
              type: ["string", "null"],
              description: "YYYY-MM-DD for options, null for stock",
            },
            fill_price: { type: "number" },
          },
          required: [
            "sign",
            "qty",
            "instrument",
            "symbol",
            "strike",
            "expiration",
            "fill_price",
          ],
        },
        description: "Required when action is open. Null otherwise.",
      },
      close_position_id: {
        type: ["string", "null"],
        description:
          "Required when action is close: UUID of YOUR open position on this symbol. Null otherwise.",
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
} as const;

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
  ivRank?: { rank: number | null; samples: number; min: number | null; max: number | null } | null;
}): string {
  const { symbol, preset, startingCapital, cash, totalEquity, openCount, thisSymbolOpen, recentClosed, marketSnapshot, ivRank } = args;
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
        p.current_value !== null && p.entry_cost > 0
          ? (p.current_value - p.entry_cost) / p.entry_cost
          : null,
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

  return `Symbol under consideration: ${symbol}

PORTFOLIO STATE:
${JSON.stringify(portfolio, null, 2)}

RECENTLY CLOSED ON ${symbol} (last 5):
${JSON.stringify(recentClosed, null, 2)}

MARKET SNAPSHOT (end-of-day data from the most recent US close):
${JSON.stringify({ ...marketSnapshot, ivRank }, null, 2)}

CONSTRAINTS:
${JSON.stringify(constraints, null, 2)}

This is your once-per-day decision for ${symbol}, made after the US close. Pick exactly one action.

OUTPUT RULES:
- "action" is "open", "close", or "hold". "confidence" is between 0 and 1.
- When "action" is "open": fill open_strategy (from allowed_strategies), open_qty (≥1), and open_legs (each leg's OCC symbol must come from marketSnapshot.horizons[].contracts). Set close_position_id and close_reason to null.
- When "action" is "close": set close_position_id to one of the UUIDs in open_positions_on_this_symbol, and close_reason. Set open_strategy, open_qty, open_legs to null.
- When "action" is "hold": set all five open_*/close_* fields to null.
- Leg fields: sign is +1 (long) or -1 (short); instrument is "stock", "call", or "put"; fill_price is the mid quote from the snapshot for that contract.
- The response shape is enforced by structured outputs — focus on quality, not formatting.`;
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------- decision validation ----------

interface ProposedOpen {
  strategy: string;
  qty: number;
  legs: Leg[];
}

function computeReservedCollateral(strategy: string, legs: Leg[], qty: number): number {
  const m = (n: number) => n * 100 * qty;
  switch (strategy) {
    case "cash_secured_put": {
      const put = legs.find((l) => l.instrument === "put" && l.sign === -1);
      if (!put?.strike) return 0;
      return m(put.strike);
    }
    case "covered_call":
      return 0;
    case "bull_put_credit_spread": {
      const shortPut = legs.find((l) => l.instrument === "put" && l.sign === -1);
      const longPut = legs.find((l) => l.instrument === "put" && l.sign === 1);
      if (!shortPut?.strike || !longPut?.strike) return 0;
      return m(Math.max(0, shortPut.strike - longPut.strike));
    }
    case "bear_call_credit_spread": {
      const shortCall = legs.find((l) => l.instrument === "call" && l.sign === -1);
      const longCall = legs.find((l) => l.instrument === "call" && l.sign === 1);
      if (!shortCall?.strike || !longCall?.strike) return 0;
      return m(Math.max(0, longCall.strike - shortCall.strike));
    }
    case "iron_condor": {
      const shortCall = legs.find((l) => l.instrument === "call" && l.sign === -1);
      const longCall = legs.find((l) => l.instrument === "call" && l.sign === 1);
      const shortPut = legs.find((l) => l.instrument === "put" && l.sign === -1);
      const longPut = legs.find((l) => l.instrument === "put" && l.sign === 1);
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

// Static, order-independent checks that depend only on the proposal and
// the agent's starting state — never on whether OTHER opens committed
// first. Anything that fails here is intrinsically infeasible and should
// be marked `skip_invalid` immediately, before ranking.
//
// The cap, runtime cash, and per-symbol concentration are NOT checked
// here — those are order-dependent (a higher-confidence open committed
// first can use up the slot/cash/headroom), and surface as
// `skip_outranked` in the commit loop.
function preValidateOpen(
  proposal: ProposedOpen,
  preset: AgentPreset,
  agent: AgentRow,
  ivHvRatio: number | null,
  ivRank: number | null,
): ValidationResult {
  if (!preset.allowed_strategies.includes(proposal.strategy)) {
    return { ok: false, reason: `strategy ${proposal.strategy} not in allowed list`, reservedCollateral: 0, computedEntryCost: 0 };
  }
  for (const leg of proposal.legs) {
    if (leg.expiration) {
      const dte = daysToExpiration(leg.expiration);
      if (dte < preset.min_dte || dte > preset.max_dte) {
        return { ok: false, reason: `leg DTE ${Math.round(dte)} outside [${preset.min_dte},${preset.max_dte}]`, reservedCollateral: 0, computedEntryCost: 0 };
      }
    }
  }
  const ivHvStr = ivHvRatio?.toFixed(2) ?? "?";
  const ivRankStr = ivRank !== null ? Math.round(ivRank * 100) + "%" : "?";
  if (preset.vol_view_required === "rich_or_fair") {
    const richOk = ivHvRatio !== null && ivHvRatio >= 1.10;
    const rankOk = ivRank !== null && ivRank >= 0.30;
    if (!richOk && !rankOk) {
      return { ok: false, reason: `vol regime cheap (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only sell premium when rich`, reservedCollateral: 0, computedEntryCost: 0 };
    }
  } else if (preset.vol_view_required === "cheap_or_fair") {
    const cheapOk = ivHvRatio !== null && ivHvRatio <= 0.95;
    const rankOk = ivRank !== null && ivRank <= 0.25;
    if (!cheapOk && !rankOk) {
      return { ok: false, reason: `vol regime rich/fair (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only buy premium when cheap`, reservedCollateral: 0, computedEntryCost: 0 };
    }
  }
  const reserved = computeReservedCollateral(proposal.strategy, proposal.legs, proposal.qty || 1);
  const cost = entryCost(proposal.legs, reserved);
  const sizeCap = agent.starting_capital * preset.max_position_size_pct;
  if (cost > sizeCap) {
    return { ok: false, reason: `position size ${cost.toFixed(0)} exceeds cap ${sizeCap.toFixed(0)}`, reservedCollateral: reserved, computedEntryCost: cost };
  }
  return { ok: true, reservedCollateral: reserved, computedEntryCost: cost };
}

function validateOpen(
  proposal: ProposedOpen,
  preset: AgentPreset,
  agent: AgentRow,
  symbol: string,
  symbolOpenCost: number,
  totalOpenCount: number,
  ivHvRatio: number | null,
  ivRank: number | null,
): ValidationResult {
  if (!preset.allowed_strategies.includes(proposal.strategy)) {
    return { ok: false, reason: `strategy ${proposal.strategy} not in allowed list`, reservedCollateral: 0, computedEntryCost: 0 };
  }
  if (totalOpenCount >= preset.max_concurrent_positions) {
    return { ok: false, reason: `at max concurrent positions (${preset.max_concurrent_positions})`, reservedCollateral: 0, computedEntryCost: 0 };
  }
  for (const leg of proposal.legs) {
    if (leg.expiration) {
      const dte = daysToExpiration(leg.expiration);
      if (dte < preset.min_dte || dte > preset.max_dte) {
        return { ok: false, reason: `leg DTE ${Math.round(dte)} outside [${preset.min_dte},${preset.max_dte}]`, reservedCollateral: 0, computedEntryCost: 0 };
      }
    }
  }
  const ivHvStr = ivHvRatio?.toFixed(2) ?? "?";
  const ivRankStr = ivRank !== null ? Math.round(ivRank * 100) + "%" : "?";
  if (preset.vol_view_required === "rich_or_fair") {
    const richOk = ivHvRatio !== null && ivHvRatio >= 1.10;
    const rankOk = ivRank !== null && ivRank >= 0.30;
    if (!richOk && !rankOk) {
      return { ok: false, reason: `vol regime cheap (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only sell premium when rich`, reservedCollateral: 0, computedEntryCost: 0 };
    }
  } else if (preset.vol_view_required === "cheap_or_fair") {
    const cheapOk = ivHvRatio !== null && ivHvRatio <= 0.95;
    const rankOk = ivRank !== null && ivRank <= 0.25;
    if (!cheapOk && !rankOk) {
      return { ok: false, reason: `vol regime rich/fair (IV/HV=${ivHvStr}, IVR=${ivRankStr}) — only buy premium when cheap`, reservedCollateral: 0, computedEntryCost: 0 };
    }
  }

  const reserved = computeReservedCollateral(proposal.strategy, proposal.legs, proposal.qty || 1);
  const cost = entryCost(proposal.legs, reserved);
  if (cost > agent.cash) {
    return { ok: false, reason: `insufficient cash: needs ${cost.toFixed(0)}, have ${agent.cash.toFixed(0)}`, reservedCollateral: reserved, computedEntryCost: cost };
  }
  const sizeCap = agent.starting_capital * preset.max_position_size_pct;
  if (cost > sizeCap) {
    return { ok: false, reason: `position size ${cost.toFixed(0)} exceeds cap ${sizeCap.toFixed(0)}`, reservedCollateral: reserved, computedEntryCost: cost };
  }
  const symCap = agent.starting_capital * preset.max_concentration_per_symbol_pct;
  if (symbolOpenCost + cost > symCap) {
    return { ok: false, reason: `concentration on ${symbol} would be ${(symbolOpenCost+cost).toFixed(0)}, cap ${symCap.toFixed(0)}`, reservedCollateral: reserved, computedEntryCost: cost };
  }
  return { ok: true, reservedCollateral: reserved, computedEntryCost: cost };
}

// ---------- Phase A: per-symbol analysis (no DB mutations) ----------

interface AnalyzeError {
  symbol: string;
  error: string;
}
interface AnalyzeOk {
  kind: "ok";
  symbol: string;
  spot: number;
  contracts: ChainContract[];
  thisSymOpen: PositionRow[];
  mtmResults: { pos: PositionRow; result: ReturnType<typeof markToMarketPosition> }[];
  marketSnapshot: any;
  ivRankInfo: { rank: number | null; samples: number; min: number | null; max: number | null } | null;
  recentClosed: any[];
  decision: any | null;
  rawText: string;
}
type AnalyzeResult = AnalyzeOk | (AnalyzeError & { kind: "error" });

// Read a fresh chain from the DB cache (filled by fetch-chains every 2 min).
// Returns null if missing or older than 10 min so the caller can fall back
// to a live Alpaca fetch. Two small queries on the normalized
// chain_quotes + chain_underlyings tables — no big JSONB through PostgREST.
const CHAIN_FRESHNESS_MS = 10 * 60_000;
async function fetchChainFromCache(
  symbol: string,
  env: Env,
): Promise<{ spot: number | null; contracts: ChainContract[]; fetchedAt: string } | null> {
  // PostgREST is configured with max-rows=1000 server-side, so a single
  // ?limit=5000 silently truncates to the first 1000 rows. NDX-100
  // underlyings routinely have 1500-3000 chain rows, which means the
  // agent's marketSnapshot was missing later expirations (37d/45d/60d
  // horizons could be entirely absent for symbols with denser front-
  // month strikes). Page through with Range headers until a short page.
  async function fetchAllQuotes(): Promise<any[]> {
    const PAGE = 1000;
    const out: any[] = [];
    let page = 0;
    for (;;) {
      const from = page * PAGE;
      const to = from + PAGE - 1;
      const url = `${env.baseUrl}/api/database/records/chain_quotes?underlying=eq.${symbol}&select=occ_symbol,expiration,strike,type,bid,ask,delta,iv&order=expiration.asc,strike.asc`;
      const res = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.apiKey}`,
          Range: `${from}-${to}`,
          "Range-Unit": "items",
          Prefer: "return=representation",
        },
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`db get chain_quotes → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const rows = (await res.json()) as any[];
      out.push(...rows);
      if (rows.length < PAGE) break;
      page++;
      if (page > 50) break;
    }
    return out;
  }

  try {
    const [underlyings, quotes] = await Promise.all([
      dbGet(
        env.baseUrl,
        env.apiKey,
        `chain_underlyings?symbol=eq.${symbol}&select=spot,fetched_at&limit=1`,
      ),
      fetchAllQuotes(),
    ]);
    if (!underlyings || underlyings.length === 0) return null;
    const u = underlyings[0];
    const fetchedAtMs = new Date(u.fetched_at).getTime();
    if (!Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs > CHAIN_FRESHNESS_MS) {
      return null;
    }
    const contracts: ChainContract[] = (quotes ?? []).map((q: any) => ({
      symbol: q.occ_symbol,
      // chain_quotes.expiration is a DATE column; PostgREST renders it as
      // "YYYY-MM-DDT00:00:00.000Z". Snapshot prompt + leg DTE math expect
      // plain "YYYY-MM-DD" (matches what parseOcc emits on the live-fetch
      // path), so slice here to keep both code paths interchangeable.
      expiration: String(q.expiration).slice(0, 10),
      strike: Number(q.strike),
      type: q.type,
      bid: q.bid == null ? null : Number(q.bid),
      ask: q.ask == null ? null : Number(q.ask),
      delta: q.delta == null ? null : Number(q.delta),
      iv: q.iv == null ? null : Number(q.iv),
    }));
    return {
      spot: u.spot == null ? null : Number(u.spot),
      contracts,
      fetchedAt: u.fetched_at,
    };
  } catch {
    return null;
  }
}

async function analyzeSymbol(
  symbol: string,
  agent: AgentRow,
  allOpen: PositionRow[],
  env: Env,
  llmClient: OpenAI,
): Promise<AnalyzeResult> {
  try {
    const recentClosedP = dbGet(
      env.baseUrl,
      env.apiKey,
      `positions?agent_id=eq.${agent.id}&symbol=eq.${symbol}&status=in.(closed,expired)&order=closed_at.desc&limit=5&select=strategy,opened_at,closed_at,realized_pnl,entry_cost`,
    );
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 365);
    const ivSnapsP = dbGet(
      env.baseUrl,
      env.apiKey,
      `iv_snapshots?symbol=eq.${symbol}&captured_at=gte.${cutoff.toISOString()}&select=atm_iv&limit=5000`,
    );

    let spot: number | null = null;
    let contracts: ChainContract[] = [];
    let hv30: number | null = null;
    const cached = await fetchChainFromCache(symbol, env);
    if (cached && cached.spot !== null) {
      spot = cached.spot;
      contracts = cached.contracts;
      const inst: { hv30: number | string | null }[] = await dbGet(
        env.baseUrl,
        env.apiKey,
        `instruments?symbol=eq.${symbol}&select=hv30&limit=1`,
      ).catch(() => []);
      const v = inst?.[0]?.hv30;
      hv30 = v == null ? null : Number(v);
    } else {
      // Live fallback for non-NDX names or when the scheduler skipped a tick.
      spot = await fetchSpot(symbol, env.alpacaKey, env.alpacaSecret);
      if (spot === null) return { kind: "error", symbol, error: "no spot" };
      const [c, h] = await Promise.all([
        fetchChain(symbol, spot, env.alpacaKey, env.alpacaSecret),
        fetchHv30(symbol, env.alpacaKey, env.alpacaSecret),
      ]);
      contracts = c;
      hv30 = h;
    }

    const [recentClosed, ivSnapsRaw] = await Promise.all([recentClosedP, ivSnapsP]);

    const thisSymOpenRaw = allOpen.filter((p) => p.symbol === symbol);
    const mtmResults = thisSymOpenRaw.map((pos) => ({
      pos,
      result: markToMarketPosition(pos, spot, contracts),
    }));
    const thisSymOpen: PositionRow[] = mtmResults.map(({ pos, result }) => ({
      ...pos,
      current_value: result.current_value ?? pos.current_value,
      legs: result.legs,
    }));

    const marketSnapshot = buildSymbolSnapshot(symbol, spot, contracts, hv30);

    let ivRankInfo: AnalyzeOk["ivRankInfo"] = null;
    if (Array.isArray(ivSnapsRaw) && marketSnapshot.atmIV !== null) {
      const ivs = ivSnapsRaw.map((s: any) => Number(s.atm_iv)).filter(Number.isFinite);
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
    });

    // Prepend a daily-cadence header so agents whose stored system_prompt
    // was templated before the intraday→daily switch still get the right
    // framing.
    const dailyCadenceAddendum = [
      "TRADING CADENCE — IMPORTANT:",
      "You evaluate this symbol exactly once per US trading day, after the market close.",
      "You will not be called again on this symbol until tomorrow's close.",
      "There is no intraday reaction available to you. Size, structure, and stop-management",
      "must assume daily-only review until the position is closed.",
      "",
    ].join("\n");
    const systemContent = `${dailyCadenceAddendum}\n${agent.system_prompt}`;
    // OpenRouter request via OpenAI-compatible SDK.
    // response_format with strict:true already constrains routing to
    // providers that natively support json_schema — that's the load-bearing
    // robustness guarantee. We do NOT set provider.require_parameters:true
    // because some models (e.g. openai/gpt-5.4) don't list `temperature`
    // in their supported_parameters, and require_parameters then filters
    // out every provider → 404 "No endpoints found". OpenRouter silently
    // drops unsupported params for the chosen provider, which is fine.
    const callLLM = async () =>
      llmClient.chat.completions.create({
        model: agent.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4048,
        response_format: { type: "json_schema", json_schema: DECISION_SCHEMA },
      });

    // Retry up to ONCE on any of:
    //   - HTTP 5xx / timeout / connection reset (transient upstream)
    //   - Successful response that parses to nothing (gemini through
    //     OpenRouter occasionally prematurely closes the stream and
    //     returns a 200 with a truncated JSON body — observed cutting
    //     off mid-string at ~600 chars, well under max_tokens)
    // After two failed attempts we surface the raw text as a parse error
    // decision so the rest of the agent's symbols still get processed.
    let llm: any = null;
    let rawText = "";
    let decision: any = null;
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
      // With strict json_schema, message.content is already valid JSON.
      // Keep extractJson as a safety net for unexpected wrapper text.
      try {
        decision = JSON.parse(rawText);
      } catch {
        decision = extractJson(rawText);
      }
      if (decision !== null) break;
      // Parse failed — retry once. Non-deterministic sampling usually
      // means the second attempt produces a complete response.
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
  } catch (e: any) {
    return { kind: "error", symbol, error: String(e?.message ?? e) };
  }
}

// ---------- Phase B: in-memory accumulate → single RPC apply ----------

async function processAgent(agent: AgentRow, env: Env, runDate: string, posthog: PostHog | null): Promise<any> {
  // OpenAI SDK pointed at OpenRouter. Single endpoint, every model accessed
  // through the same API. Structured outputs are enforced via
  // response_format.json_schema (set in analyzeSymbol below), and
  // provider.require_parameters:true makes OpenRouter route only to
  // providers that actually honor the schema param — eliminates the
  // "malformed JSON from a non-supporting provider" failure we hit before.
  if (!env.openrouterKey) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }
  const llmClient = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.openrouterKey,
    timeout: 600_000,
  });

  const allOpen: PositionRow[] = await dbGet(
    env.baseUrl,
    env.apiKey,
    `positions?agent_id=eq.${agent.id}&status=eq.open&order=opened_at.asc&limit=200`,
  );

  // Phase A: analyze every watched symbol in parallel. Each call sees the
  // same starting state (no knowledge of what other symbols decided).
  // We deliberately don't thread running state through, because Phase B
  // ranks the resulting open proposals by confidence and commits the top
  // K — order during analysis would bias the outcome.
  const phaseA = await Promise.all(
    agent.watched_symbols.map((symbol) => analyzeSymbol(symbol, agent, allOpen, env, llmClient)),
  );

  // Phase B: handle MTM + closes (deterministic, no ranking), then
  // collect open proposals, rank by confidence, greedy-commit until
  // cap/cash/concentration is exhausted. Surplus opens are recorded as
  // `skip_outranked` so the user can see which signals lost the race.
  let cash = Number(agent.cash);
  const symbolBlobs: any[] = [];
  const expires: any[] = [];
  const mtmUpdates: any[] = [];
  const closes: any[] = [];
  const opens: any[] = [];
  const decisions: any[] = [];

  const finalOpen = new Map<string, { entry_cost: number; current_value: number }>();
  for (const p of allOpen) {
    finalOpen.set(p.id, {
      entry_cost: Number(p.entry_cost),
      current_value: Number(p.current_value ?? p.entry_cost),
    });
  }

  // Running per-symbol open cost — used for the concentration check at
  // commit time. Initialized from existing positions, mutated as closes
  // and new opens land.
  const symbolOpenCost = new Map<string, number>();
  for (const p of allOpen) {
    symbolOpenCost.set(p.symbol, (symbolOpenCost.get(p.symbol) ?? 0) + Number(p.entry_cost));
  }

  interface OpenCandidate {
    r: AnalyzeOk;
    proposal: ProposedOpen;
    refilledLegs: Leg[];
    confidence: number;
    reasoning: string;
    decision: any;
    marketSnapshot: any;
    reservedCollateral: number;
    cost: number;
  }
  const openCandidates: OpenCandidate[] = [];

  for (const r of phaseA) {
    if (r.kind === "error") {
      decisions.push({
        symbol: r.symbol,
        action: "error",
        confidence: null,
        reasoning: r.error.slice(0, 500),
        position_id: null,
        snapshot: null,
        raw_response: null,
        validation_notes: null,
      });
      symbolBlobs.push({ symbol: r.symbol, error: r.error.slice(0, 200) });
      continue;
    }

    for (const { pos, result } of r.mtmResults) {
      const allExpired = pos.legs.every(
        (l) => l.expiration && new Date(l.expiration + "T20:00:00Z") < new Date(),
      );
      if (allExpired && result.current_value !== null) {
        const realized = result.current_value - pos.entry_cost;
        expires.push({
          position_id: pos.id,
          exit_proceeds: result.current_value,
          realized_pnl: realized,
          current_value: result.current_value,
          legs: result.legs,
        });
        cash += result.current_value;
        finalOpen.delete(pos.id);
        symbolOpenCost.set(pos.symbol, (symbolOpenCost.get(pos.symbol) ?? 0) - Number(pos.entry_cost));
      } else if (result.current_value !== null) {
        mtmUpdates.push({
          position_id: pos.id,
          current_value: result.current_value,
          legs: result.legs,
        });
        const fp = finalOpen.get(pos.id);
        if (fp) fp.current_value = result.current_value;
        pos.current_value = result.current_value;
        pos.legs = result.legs;
      }
    }

    const remainingOpen = r.thisSymOpen.filter((p) => finalOpen.has(p.id));
    const decision = r.decision;
    const marketSnapshot = r.marketSnapshot;

    if (!decision) {
      decisions.push({
        symbol: r.symbol,
        action: "error",
        confidence: null,
        reasoning: "Failed to parse JSON from model.",
        position_id: null,
        snapshot: marketSnapshot,
        raw_response: { raw: r.rawText },
        validation_notes: null,
      });
      symbolBlobs.push({ symbol: r.symbol, action: "error" });
      continue;
    }

    const action = String(decision.action ?? "hold");
    const confidence = typeof decision.confidence === "number" ? decision.confidence : null;
    const reasoning = String(decision.reasoning ?? "").slice(0, 1000);

    if (action === "hold") {
      decisions.push({
        symbol: r.symbol,
        action: "hold",
        confidence,
        reasoning,
        position_id: null,
        snapshot: marketSnapshot,
        raw_response: decision,
        validation_notes: null,
      });
      symbolBlobs.push({ symbol: r.symbol, action: "hold" });
      continue;
    }

    if (action === "close") {
      const positionId = decision.close_position_id;
      const target = remainingOpen.find((p) => p.id === positionId);
      if (!target) {
        decisions.push({
          symbol: r.symbol,
          action: "skip_invalid",
          confidence,
          reasoning,
          position_id: null,
          snapshot: marketSnapshot,
          raw_response: decision,
          validation_notes: `position_id ${positionId} not found among open ${r.symbol} positions`,
        });
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      if (target.current_value === null) {
        decisions.push({
          symbol: r.symbol,
          action: "skip_invalid",
          confidence,
          reasoning,
          position_id: target.id,
          snapshot: marketSnapshot,
          raw_response: decision,
          validation_notes: "MTM unavailable; cannot close",
        });
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      const realized = target.current_value - target.entry_cost;
      closes.push({
        position_id: target.id,
        exit_proceeds: target.current_value,
        realized_pnl: realized,
      });
      cash += target.current_value;
      finalOpen.delete(target.id);
      symbolOpenCost.set(target.symbol, (symbolOpenCost.get(target.symbol) ?? 0) - Number(target.entry_cost));
      decisions.push({
        symbol: r.symbol,
        action: "close",
        confidence,
        reasoning,
        position_id: target.id,
        snapshot: marketSnapshot,
        raw_response: decision,
        validation_notes: null,
      });
      posthog?.capture({
        distinctId: agent.slug,
        event: "agent_position_closed",
        properties: {
          agent_slug: agent.slug,
          agent_focus: agent.focus,
          symbol: r.symbol,
          realized_pnl: realized,
          exit_proceeds: target.current_value,
          run_date: runDate,
        },
      });
      symbolBlobs.push({ symbol: r.symbol, action: "close", realized });
      continue;
    }

    if (action === "open") {
      const proposal: ProposedOpen | null =
        decision.open_strategy && Array.isArray(decision.open_legs)
          ? {
              strategy: String(decision.open_strategy),
              qty: Number(decision.open_qty ?? 1),
              legs: decision.open_legs as Leg[],
            }
          : null;
      if (!proposal || !Array.isArray(proposal.legs)) {
        decisions.push({
          symbol: r.symbol,
          action: "skip_invalid",
          confidence,
          reasoning,
          position_id: null,
          snapshot: marketSnapshot,
          raw_response: decision,
          validation_notes: "missing open_strategy or open_legs",
        });
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
        continue;
      }
      if (confidence === null || confidence < agent.preset.min_confidence_to_trade) {
        decisions.push({
          symbol: r.symbol,
          action: "skip_low_confidence",
          confidence,
          reasoning,
          position_id: null,
          snapshot: marketSnapshot,
          raw_response: decision,
          validation_notes: `confidence ${confidence} < floor ${agent.preset.min_confidence_to_trade}`,
        });
        symbolBlobs.push({ symbol: r.symbol, action: "skip_low_confidence" });
        continue;
      }
      const refilledLegs: Leg[] = proposal.legs.map((l) => {
        if (l.instrument === "stock") {
          return { ...l, sign: l.sign as 1 | -1, fill_price: r.spot, current_price: r.spot };
        }
        const c = r.contracts.find((x) => x.symbol === l.symbol);
        const m = c ? midOf(c) : null;
        return {
          ...l,
          sign: l.sign as 1 | -1,
          fill_price: m ?? l.fill_price,
          current_price: m ?? l.fill_price,
        };
      });
      // Static checks (strategy / dte / vol regime / size cap) decided
      // now — these don't depend on what other symbols commit. The
      // order-dependent gates (cap, runtime cash, concentration) run
      // later in the ranked commit loop.
      const pre = preValidateOpen(
        { ...proposal, legs: refilledLegs, qty: proposal.qty || 1 },
        agent.preset,
        agent,
        marketSnapshot.ivHvRatio,
        r.ivRankInfo?.rank ?? null,
      );
      if (!pre.ok) {
        decisions.push({
          symbol: r.symbol,
          action: "skip_invalid",
          confidence,
          reasoning,
          position_id: null,
          snapshot: marketSnapshot,
          raw_response: decision,
          validation_notes: pre.reason,
        });
        symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid", reason: pre.reason });
        continue;
      }
      openCandidates.push({
        r,
        proposal: { ...proposal, legs: refilledLegs, qty: proposal.qty || 1 },
        refilledLegs,
        confidence: confidence as number,
        reasoning,
        decision,
        marketSnapshot,
        reservedCollateral: pre.reservedCollateral,
        cost: pre.computedEntryCost,
      });
      continue;
    }

    decisions.push({
      symbol: r.symbol,
      action: "skip_invalid",
      confidence,
      reasoning,
      position_id: null,
      snapshot: marketSnapshot,
      raw_response: decision,
      validation_notes: `unknown action: ${action}`,
    });
    symbolBlobs.push({ symbol: r.symbol, action: "skip_invalid" });
  }

  // ---- Ranked commit: highest-confidence opens win ----
  openCandidates.sort((a, b) => b.confidence - a.confidence);
  const cap = agent.preset.max_concurrent_positions;
  const symCap = agent.starting_capital * agent.preset.max_concentration_per_symbol_pct;
  for (const cand of openCandidates) {
    // Cap, runtime cash, and per-symbol concentration are all
    // order-dependent: a higher-confidence open committed earlier in this
    // loop can use the slot, the cash, or the symbol headroom that this
    // one needed. Any of these failing here → skip_outranked.
    const reasons: string[] = [];
    if (finalOpen.size >= cap) {
      reasons.push(`at max concurrent positions (${cap})`);
    }
    if (cand.cost > cash) {
      reasons.push(`insufficient cash after prior commits: needs ${cand.cost.toFixed(0)}, have ${cash.toFixed(0)}`);
    }
    const symRunning = symbolOpenCost.get(cand.r.symbol) ?? 0;
    if (symRunning + cand.cost > symCap) {
      reasons.push(`concentration on ${cand.r.symbol} would be ${(symRunning + cand.cost).toFixed(0)}, cap ${symCap.toFixed(0)}`);
    }
    if (reasons.length > 0) {
      const note = `outranked by higher-confidence opens: ${reasons.join("; ")}`;
      decisions.push({
        symbol: cand.r.symbol,
        action: "skip_outranked",
        confidence: cand.confidence,
        reasoning: cand.reasoning,
        position_id: null,
        snapshot: cand.marketSnapshot,
        raw_response: cand.decision,
        validation_notes: note,
      });
      symbolBlobs.push({ symbol: cand.r.symbol, action: "skip_outranked", reason: note });
      continue;
    }
    opens.push({
      symbol: cand.r.symbol,
      strategy: cand.proposal.strategy,
      legs: cand.refilledLegs,
      reserved_collateral: cand.reservedCollateral,
      entry_cost: cand.cost,
      rationale: cand.reasoning,
      _decision: {
        action: "open",
        confidence: cand.confidence,
        reasoning: cand.reasoning,
        snapshot: cand.marketSnapshot,
        raw_response: cand.decision,
        validation_notes: null,
      },
    });
    cash -= cand.cost;
    finalOpen.set(`new-${opens.length}`, {
      entry_cost: cand.cost,
      current_value: cand.cost,
    });
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

  const positionsMtm = Array.from(finalOpen.values()).reduce(
    (s, p) => s + (p.current_value ?? p.entry_cost),
    0,
  );
  const totalEquity = cash + positionsMtm;

  // Single atomic apply — positions, agents.cash, decisions, equity_snapshot
  // all in one Postgres transaction via apply_agent_tick.
  const result = await dbRpc(env.baseUrl, env.apiKey, "apply_agent_tick", {
    payload: {
      agent_id: agent.id,
      run_date: runDate,
      final_cash: cash,
      expires,
      mtm_updates: mtmUpdates,
      closes,
      opens,
      decisions,
      equity: {
        cash,
        positions_mtm: positionsMtm,
        total_equity: totalEquity,
        open_positions: finalOpen.size,
      },
    },
  });

  return {
    agent: agent.slug,
    cash,
    positions_mtm: positionsMtm,
    total_equity: totalEquity,
    open_positions: finalOpen.size,
    applied: result,
    actions: symbolBlobs,
  };
}

// Wraps processAgent with per-agent status tracking. Always writes a
// terminal agent_runs row, even on failure. Returns a structured summary
// the batch caller can include in its response.
async function runAgentWithStatus(
  agent: AgentRow,
  env: Env,
  runDate: string,
  posthog: PostHog | null,
): Promise<any> {
  const startedAt = new Date().toISOString();
  await dbUpsert(env.baseUrl, env.apiKey, "agent_runs", [
    {
      run_date: runDate,
      agent_slug: agent.slug,
      status: "running",
      started_at: startedAt,
    },
  ]).catch(() => {});

  try {
    const result = await processAgent(agent, env, runDate, posthog);
    await dbUpsert(env.baseUrl, env.apiKey, "agent_runs", [
      {
        run_date: runDate,
        agent_slug: agent.slug,
        status: "done",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: null,
      },
    ]).catch(() => {});
    return { slug: agent.slug, ok: true, result };
  } catch (e: any) {
    const errMsg = String(e?.message ?? e).slice(0, 500);
    await dbUpsert(env.baseUrl, env.apiKey, "agent_runs", [
      {
        run_date: runDate,
        agent_slug: agent.slug,
        status: "error",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: errMsg,
      },
    ]).catch(() => {});
    return { slug: agent.slug, ok: false, error: errMsg };
  }
}

// ---------- handler ----------

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const expected = Deno.env.get("SCHEDULE_SECRET") ?? "";
  const provided = req.headers.get("X-Schedule-Secret") ?? "";
  if (!expected || expected !== provided) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const posthog = createPostHog();

  const env: Env = {
    alpacaKey: Deno.env.get("ALPACA_API_KEY") ?? "",
    alpacaSecret: Deno.env.get("ALPACA_API_SECRET") ?? "",
    baseUrl: Deno.env.get("INSFORGE_BASE_URL") ?? "",
    apiKey: Deno.env.get("API_KEY") ?? "",
    openrouterKey: Deno.env.get("OPENROUTER_API_KEY") ?? "",
  };
  if (!env.alpacaKey || env.alpacaKey === "PLACEHOLDER_REPLACE_ME") {
    return new Response(JSON.stringify({ error: "Alpaca creds not configured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!env.baseUrl || !env.apiKey) {
    return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!env.openrouterKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;
    const explicitSlug = body?.slug as string | undefined;
    const runDate = (body?.run_date as string | undefined) ?? etTodayDate();
    const startedAt = Date.now();

    // ---- Single-slug debug mode ----
    if (explicitSlug) {
      const agents: AgentRow[] = await dbGet(
        env.baseUrl,
        env.apiKey,
        `agents?slug=eq.${explicitSlug}&active=eq.true&limit=1`,
      );
      if (agents.length === 0) {
        return new Response(
          JSON.stringify({ error: `no active agent with slug ${explicitSlug}` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await runAgentWithStatus(agents[0], env, runDate, posthog);
      await posthog?.shutdown();
      return new Response(
        JSON.stringify({ tickedAt: new Date().toISOString(), runDate, mode: "single", result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Batch mode (cron path) ----
    // Trading-day gate. Default: open Mon-Fri. Exception: market_holidays
    // rows where early_close_et IS NULL (full closure) skip; rows with a
    // time set are half-days where agents still run post-close.
    if (!force) {
      const dow = new Date(`${runDate}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "weekend", runDate }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const holidays: { early_close_et: string | null }[] = await dbGet(
        env.baseUrl,
        env.apiKey,
        `market_holidays?date=eq.${runDate}&select=early_close_et&limit=1`,
      ).catch(() => []);
      if (holidays.length > 0 && holidays[0].early_close_et === null) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "holiday — full closure", runDate }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const allAgents: AgentRow[] = await dbGet(
      env.baseUrl,
      env.apiKey,
      `agents?active=eq.true&select=*&limit=500`,
    );
    if (allAgents.length === 0) {
      return new Response(JSON.stringify({ skipped: true, reason: "no active agents" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent rerun. Skip already-'done'/'running' agents; skip recent
    // 'pending' (still in flight); retry stale 'pending' and 'error'.
    const todayRuns: {
      agent_slug: string;
      status: string;
      dispatched_at: string | null;
      started_at: string | null;
    }[] = await dbGet(
      env.baseUrl,
      env.apiKey,
      `agent_runs?run_date=eq.${runDate}&select=agent_slug,status,dispatched_at,started_at&limit=1000`,
    );
    const now = Date.now();
    const skipSlugs = new Set<string>();
    for (const r of todayRuns) {
      if (r.status === "done") {
        skipSlugs.add(r.agent_slug);
      } else if (r.status === "running") {
        // A "running" row whose started_at is older than the staleness
        // window is treated as a dead run — the function probably 502'd
        // or got killed before it could write a terminal status. Without
        // this, a single platform hiccup at :10 leaves the agent stuck
        // forever and the :50 backstop can't recover it. Within the
        // window, assume the run is genuinely in flight and skip it.
        const startedMs = r.started_at ? new Date(r.started_at).getTime() : 0;
        if (now - startedMs < STALE_PENDING_MS) skipSlugs.add(r.agent_slug);
      } else if (r.status === "pending") {
        const dispatchedMs = r.dispatched_at ? new Date(r.dispatched_at).getTime() : 0;
        if (now - dispatchedMs < STALE_PENDING_MS) skipSlugs.add(r.agent_slug);
      }
    }
    const agentsToProcess = allAgents.filter((a) => !skipSlugs.has(a.slug));
    const skipped = allAgents.length - agentsToProcess.length;
    if (agentsToProcess.length === 0) {
      return new Response(
        JSON.stringify({
          skipped: true,
          reason: "all agents already done/in-flight for today",
          runDate,
          totalAgents: allAgents.length,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Pre-create 'pending' rows so any observer (dashboard, monitoring) can
    // see in-flight runs immediately. Idempotent on PK conflict.
    const dispatchedAt = new Date().toISOString();
    await dbUpsert(
      env.baseUrl,
      env.apiKey,
      "agent_runs",
      agentsToProcess.map((a) => ({
        run_date: runDate,
        agent_slug: a.slug,
        status: "pending",
        dispatched_at: dispatchedAt,
      })),
    ).catch(() => {});

    // Bounded-parallel batch: BATCH_CONCURRENCY agents in flight at a time.
    // Each agent's Phase A already fans out across its watched symbols
    // (~10 LLM calls), so peak in-flight LLM calls = BATCH_CONCURRENCY * 10.
    const results: any[] = [];
    for (let i = 0; i < agentsToProcess.length; i += BATCH_CONCURRENCY) {
      const batch = agentsToProcess.slice(i, i + BATCH_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((a) => runAgentWithStatus(a, env, runDate, posthog).catch((e: any) => ({
          slug: a.slug,
          ok: false,
          error: String(e?.message ?? e).slice(0, 500),
        }))),
      );
      results.push(...batchResults);
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    const elapsedMs = Date.now() - startedAt;

    posthog?.capture({
      distinctId: "system",
      event: "agent_tick_completed",
      properties: {
        mode: "batch",
        run_date: runDate,
        total_agents: allAgents.length,
        skipped,
        dispatched: agentsToProcess.length,
        succeeded,
        failed,
        elapsed_ms: elapsedMs,
      },
    });
    await posthog?.shutdown();

    return new Response(
      JSON.stringify({
        tickedAt: new Date().toISOString(),
        runDate,
        mode: "batch",
        elapsedMs,
        totalAgents: allAgents.length,
        skipped,
        dispatched: agentsToProcess.length,
        succeeded,
        failed,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    posthog?.captureException(err, "system");
    await posthog?.shutdown();
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
