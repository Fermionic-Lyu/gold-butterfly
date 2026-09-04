// Full option chains for the NDX-100 → chain_quotes + chain_underlyings, plus
// an ATM-IV sample into iv_snapshots on the :00/:30 ticks.
//
// Per tick: 1 batched spot call + ~100 paginated chain calls. HV30 is not
// touched here; fetch-daily-bars owns it.

import { bulkUpsert, execute } from "../db.ts";
import { ALPACA_DATA, alpacaFetch, parseOcc, requireAlpaca } from "./shared/alpaca.ts";
import { etTodayDate, isMarketOpen, tradingDaySkipReason } from "./shared/market-time.ts";
import { ndxSymbols } from "./shared/universe.ts";
import { chunkedAll, errMsg } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

const STRIKE_BAND_FRACTION = 0.35;
const HORIZON_DAYS = 400;
// 6 chains in parallel, 700ms between batches ≈ 5 req/s for ~25s — well under
// Alpaca's 200/min budget with the spot call included.
const PARALLEL_CHUNK = 6;
const INTER_BATCH_DELAY_MS = 700;

interface ChainContractOut {
  symbol: string;
  expiration: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  openInterest: number | null;
  volume: number | null;
  updated: string | null;
}

interface IvSnapshotRow {
  symbol: string;
  captured_at: string;
  spot: number | null;
  atm_iv: number | null;
  atm_call_iv: number | null;
  atm_put_iv: number | null;
  primary_expiration: string | null;
  primary_dte: number | null;
  hv30: null;
}

// ATM IV at the expiration nearest 30 DTE: call/put nearest spot, averaged.
function deriveAtmSnapshot(
  symbol: string,
  spot: number,
  contracts: ChainContractOut[],
  capturedAt: string,
): IvSnapshotRow | null {
  if (contracts.length === 0) return null;
  const now = new Date(capturedAt).getTime();
  const byExp = new Map<
    string,
    { call?: ChainContractOut; put?: ChainContractOut; bestCallDiff: number; bestPutDiff: number }
  >();
  for (const c of contracts) {
    let bucket = byExp.get(c.expiration);
    if (!bucket) {
      bucket = { bestCallDiff: Infinity, bestPutDiff: Infinity };
      byExp.set(c.expiration, bucket);
    }
    const diff = Math.abs(c.strike - spot);
    if (c.type === "call" && diff < bucket.bestCallDiff) {
      bucket.call = c;
      bucket.bestCallDiff = diff;
    } else if (c.type === "put" && diff < bucket.bestPutDiff) {
      bucket.put = c;
      bucket.bestPutDiff = diff;
    }
  }
  let chosenExp: string | null = null;
  let chosenDiff = Infinity;
  for (const exp of byExp.keys()) {
    const days = (new Date(exp + "T16:00:00Z").getTime() - now) / 86_400_000;
    const d = Math.abs(days - 30);
    if (d < chosenDiff) {
      chosenDiff = d;
      chosenExp = exp;
    }
  }
  if (!chosenExp) return null;
  const bucket = byExp.get(chosenExp)!;
  const callIv = typeof bucket.call?.iv === "number" ? bucket.call.iv : null;
  const putIv = typeof bucket.put?.iv === "number" ? bucket.put.iv : null;
  if (callIv === null && putIv === null) return null;
  const atmIv = callIv !== null && putIv !== null ? (callIv + putIv) / 2 : (callIv ?? putIv);
  const dte = Math.round((new Date(chosenExp + "T16:00:00Z").getTime() - now) / 86_400_000);
  return {
    symbol,
    captured_at: capturedAt,
    spot,
    atm_iv: atmIv,
    atm_call_iv: callIv,
    atm_put_iv: putIv,
    primary_expiration: chosenExp,
    primary_dte: dte,
    hv30: null,
  };
}

type Spot = { price: number | null; source: string; timestamp: string | null };

// Latest trade preferred, quote midpoint as fallback — the free IEX feed
// often has one but not the other.
async function fetchSpotsBatch(symbols: string[]): Promise<Record<string, Spot>> {
  const csv = symbols.join(",");
  const [trades, quotes] = await Promise.all([
    alpacaFetch(`${ALPACA_DATA}/v2/stocks/trades/latest?symbols=${csv}&feed=iex`).catch(() => null),
    alpacaFetch(`${ALPACA_DATA}/v2/stocks/quotes/latest?symbols=${csv}&feed=iex`).catch(() => null),
  ]);
  const out: Record<string, Spot> = {};
  for (const sym of symbols) {
    const t = trades?.trades?.[sym];
    if (t && typeof t.p === "number" && t.p > 0) {
      out[sym] = { price: t.p, source: "trade", timestamp: t.t ?? null };
      continue;
    }
    const q = quotes?.quotes?.[sym];
    if (q && typeof q.bp === "number" && typeof q.ap === "number" && q.bp > 0 && q.ap > 0) {
      out[sym] = { price: (q.bp + q.ap) / 2, source: "quote-mid", timestamp: q.t ?? null };
      continue;
    }
    out[sym] = { price: null, source: "unavailable", timestamp: null };
  }
  return out;
}

async function fetchChainForSymbol(symbol: string, spot: number) {
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);
  const band = spot * STRIKE_BAND_FRACTION;
  const strikeMin = Math.max(0, spot - band);
  const strikeMax = spot + band;

  const all: Record<string, any> = {};
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${ALPACA_DATA}/v1beta1/options/snapshots/${symbol}`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("strike_price_gte", strikeMin.toFixed(2));
    url.searchParams.set("strike_price_lte", strikeMax.toFixed(2));
    url.searchParams.set("expiration_date_lte", horizon.toISOString().slice(0, 10));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await alpacaFetch(url.toString());
    if (data?.snapshots) Object.assign(all, data.snapshots);
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < 5);

  const contracts: ChainContractOut[] = [];
  for (const [occ, snap] of Object.entries<any>(all)) {
    const p = parseOcc(occ);
    if (!p) continue;
    const q = snap?.latestQuote;
    const t = snap?.latestTrade;
    const g = snap?.greeks;
    const d = snap?.dailyBar;
    contracts.push({
      symbol: occ,
      expiration: p.expiration,
      strike: p.strike,
      type: p.type,
      bid: q?.bp ?? null,
      ask: q?.ap ?? null,
      bidSize: q?.bs ?? null,
      askSize: q?.as ?? null,
      last: t?.p ?? null,
      iv: snap?.impliedVolatility ?? null,
      delta: g?.delta ?? null,
      gamma: g?.gamma ?? null,
      theta: g?.theta ?? null,
      vega: g?.vega ?? null,
      rho: g?.rho ?? null,
      openInterest: snap?.openInterest ?? null,
      // dailyBar.v is cumulative day volume; the latest trade's size is only a fallback.
      volume: typeof d?.v === "number" ? d.v : t?.s ?? null,
      updated: q?.t ?? t?.t ?? null,
    });
  }
  const expirations = Array.from(new Set(contracts.map((c) => c.expiration))).sort();
  return { contracts, expirations, band: { min: strikeMin, max: strikeMax } };
}

const QUOTE_COLUMNS = [
  "underlying", "occ_symbol", "expiration", "strike", "type",
  "bid", "ask", "bid_size", "ask_size", "last", "iv",
  "delta", "gamma", "theta", "vega", "rho",
  "open_interest", "volume", "updated", "fetched_at",
];
const UNDERLYING_COLUMNS = [
  "symbol", "spot", "spot_source", "spot_ts", "expirations",
  "contract_count", "strike_min", "strike_max", "fetched_at",
];
const IV_COLUMNS = [
  "symbol", "captured_at", "spot", "atm_iv", "atm_call_iv", "atm_put_iv",
  "primary_expiration", "primary_dte", "hv30",
];

export async function fetchChains(args: JobArgs) {
  requireAlpaca();
  const force = args.force === true;
  const market = isMarketOpen();
  if (!market.open && !force) return { skipped: true, reason: market.reason, etTime: market.etTime };
  if (!force) {
    const reason = await tradingDaySkipReason(etTodayDate());
    if (reason) return { skipped: true, reason };
  }

  const startedAt = Date.now();
  const symbols = await ndxSymbols();
  if (symbols.length === 0) throw new Error("no NDX symbols in instruments table");

  const spots = await fetchSpotsBatch(symbols);
  const fetchedAt = new Date().toISOString();
  const failures: { symbol: string; error: string }[] = [];
  const underlyingRows: Record<string, unknown>[] = [];
  const quoteRows: Record<string, unknown>[] = [];
  const ivRows: IvSnapshotRow[] = [];

  // IV is sampled on the half-hour only; forced off-cadence runs would
  // otherwise pollute the series. capture_iv:true overrides for testing.
  const captureMinute = new Date(fetchedAt).getUTCMinutes();
  const captureIv = captureMinute === 0 || captureMinute === 30 || args.capture_iv === true;

  await chunkedAll(symbols, PARALLEL_CHUNK, INTER_BATCH_DELAY_MS, async (sym) => {
    const u = spots[sym];
    if (!u || u.price === null) {
      failures.push({ symbol: sym, error: "no spot" });
      return;
    }
    try {
      const { contracts, expirations, band } = await fetchChainForSymbol(sym, u.price);
      underlyingRows.push({
        symbol: sym,
        spot: u.price,
        spot_source: u.source,
        spot_ts: u.timestamp,
        expirations,
        contract_count: contracts.length,
        strike_min: band.min,
        strike_max: band.max,
        fetched_at: fetchedAt,
      });
      for (const c of contracts) {
        quoteRows.push({
          underlying: sym,
          occ_symbol: c.symbol,
          expiration: c.expiration,
          strike: c.strike,
          type: c.type,
          bid: c.bid,
          ask: c.ask,
          bid_size: c.bidSize,
          ask_size: c.askSize,
          last: c.last,
          iv: c.iv,
          delta: c.delta,
          gamma: c.gamma,
          theta: c.theta,
          vega: c.vega,
          rho: c.rho,
          open_interest: c.openInterest,
          volume: c.volume,
          updated: c.updated,
          fetched_at: fetchedAt,
        });
      }
      if (captureIv) {
        const iv = deriveAtmSnapshot(sym, u.price, contracts, fetchedAt);
        if (iv) ivRows.push(iv);
      }
    } catch (e) {
      failures.push({ symbol: sym, error: errMsg(e, 200) });
    }
  });

  const upsertFailures: { table: string; error: string }[] = [];
  let underlyingsStored = 0;
  try {
    underlyingsStored = await bulkUpsert("chain_underlyings", UNDERLYING_COLUMNS, underlyingRows, ["symbol"]);
  } catch (e) {
    upsertFailures.push({ table: "chain_underlyings", error: errMsg(e, 200) });
  }
  let quotesStored = 0;
  try {
    quotesStored = await bulkUpsert("chain_quotes", QUOTE_COLUMNS, quoteRows, ["underlying", "occ_symbol"], {
      chunk: 1000,
    });
  } catch (e) {
    upsertFailures.push({ table: "chain_quotes", error: errMsg(e, 200) });
  }

  // Contracts not refreshed this tick fell out of the universe (expired,
  // delisted strike); sweep them so the table stays bounded.
  let swept = 0;
  if (quotesStored > 0 && upsertFailures.length === 0) {
    swept = await execute("DELETE FROM chain_quotes WHERE fetched_at < $1", [fetchedAt]).catch(() => 0);
  }

  let ivInserted = 0;
  let ivError: string | null = null;
  if (ivRows.length > 0) {
    try {
      ivInserted = await bulkUpsert("iv_snapshots", IV_COLUMNS, ivRows as any[], ["symbol", "captured_at"], {
        update: "none",
      });
    } catch (e) {
      ivError = errMsg(e, 200);
    }
  }

  return {
    capturedAt: fetchedAt,
    symbolsRequested: symbols.length,
    underlyingsStored,
    quoteRowsStored: quotesStored,
    staleQuotesSwept: swept,
    ivCaptured: captureIv,
    ivInserted,
    ivError,
    fetchFailures: failures,
    upsertFailures,
    elapsedMs: Date.now() - startedAt,
  };
}
