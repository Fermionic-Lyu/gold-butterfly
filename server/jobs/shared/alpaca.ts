import { env } from "../../env.ts";
import { sleep } from "./util.ts";

export const ALPACA_DATA = "https://data.alpaca.markets";
export const ALPACA_TRADING = "https://paper-api.alpaca.markets";

export class AlpacaNotConfigured extends Error {
  constructor() {
    super("Alpaca credentials not configured (ALPACA_API_KEY / ALPACA_API_SECRET)");
  }
}

export function requireAlpaca() {
  if (!env.alpacaKey || !env.alpacaSecret) throw new AlpacaNotConfigured();
}

// Retries 429 and 5xx: a brief upstream hiccup otherwise costs a whole tick
// of data across the universe.
export async function alpacaFetch(url: string, attempt = 0): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": env.alpacaKey,
      "APCA-API-SECRET-KEY": env.alpacaSecret,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (transient && attempt < 3) {
    await sleep(600 * Math.pow(2, attempt));
    return alpacaFetch(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export interface OccParts {
  type: "call" | "put";
  strike: number;
  expiration: string;
}

export function parseOcc(occ: string): OccParts | null {
  const m = occ.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const ymd = m[1];
  return {
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: m[2] === "C" ? "call" : "put",
    strike: parseInt(m[3], 10) / 1000,
  };
}

export interface BarRow {
  symbol: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Walks the paginated multi-symbol bars response:
// { bars: { AAPL: [{...}], ... }, next_page_token }
export async function fetchBars(
  symbols: string[],
  timeframe: "1Min" | "1Day",
  start: string,
  end: string,
  opts: { adjustment: "raw" | "split"; maxPages: number },
): Promise<BarRow[]> {
  const out: BarRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${ALPACA_DATA}/v2/stocks/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("adjustment", opts.adjustment);
    url.searchParams.set("feed", "iex");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await alpacaFetch(url.toString());
    const bars = (data?.bars ?? {}) as Record<string, any[]>;
    for (const [sym, arr] of Object.entries(bars)) {
      if (!Array.isArray(arr)) continue;
      for (const b of arr) {
        if (typeof b?.t !== "string" || typeof b?.c !== "number") continue;
        out.push({
          symbol: sym,
          ts: b.t,
          open: Number(b.o),
          high: Number(b.h),
          low: Number(b.l),
          close: Number(b.c),
          volume: Number(b.v ?? 0),
        });
      }
    }
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < opts.maxPages);
  return out;
}

export async function fetchSpot(symbol: string): Promise<number | null> {
  try {
    const t = await alpacaFetch(`${ALPACA_DATA}/v2/stocks/${symbol}/trades/latest?feed=iex`);
    if (typeof t?.trade?.p === "number") return t.trade.p;
  } catch {
    // fall through to the quote midpoint
  }
  try {
    const q = await alpacaFetch(`${ALPACA_DATA}/v2/stocks/${symbol}/quotes/latest?feed=iex`);
    if (typeof q?.quote?.bp === "number" && typeof q?.quote?.ap === "number") {
      return (q.quote.bp + q.quote.ap) / 2;
    }
  } catch {
    // no spot available
  }
  return null;
}

export function hv30FromCloses(closes: number[]): number | null {
  if (closes.length < 11) return null;
  const slice = closes.slice(-31);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Live HV30 for symbols outside daily_bars (non-NDX names).
export async function fetchHv30Live(symbol: string): Promise<number | null> {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 60);
  const url =
    `${ALPACA_DATA}/v2/stocks/${symbol}/bars?timeframe=1Day` +
    `&start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}` +
    `&limit=60&adjustment=split&feed=iex`;
  try {
    const data = await alpacaFetch(url);
    const closes = (data?.bars ?? []).map((b: any) => b.c).filter((x: any) => Number.isFinite(x));
    return hv30FromCloses(closes);
  } catch {
    return null;
  }
}

export interface ChainContractLite {
  symbol: string;
  expiration: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  delta: number | null;
  iv: number | null;
}

// Live chain for the trading tick's fallback path (90-day horizon, ±40% band).
export async function fetchChainLive(symbol: string, spot: number): Promise<ChainContractLite[]> {
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
    const data = await alpacaFetch(url.toString());
    if (data?.snapshots) Object.assign(all, data.snapshots);
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < 8);

  const contracts: ChainContractLite[] = [];
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
