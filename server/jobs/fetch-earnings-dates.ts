// Finnhub earnings calendar → earnings_dates, scoped to the instrument
// universe. Global sweep in 7-day chunks (each call silently caps at ~1500
// rows), then a per-symbol pass for names the sweep dropped.

import { bulkUpsert, query } from "../db.ts";
import { FH_BASE, finnhubFetch, requireFinnhub, withToken } from "./shared/finnhub.ts";
import { addDays, errMsg, ymd } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

const DEFAULT_LOOKBACK_DAYS = 0;
const DEFAULT_LOOKAHEAD_DAYS = 95;
const CHUNK_DAYS = 7;
const MAX_TOTAL_DAYS = 1825;
const FH_MIN_GAP_MS = 250;

interface FinnhubRow {
  date?: string;
  symbol?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
}

interface EarningsRow {
  symbol: string;
  date: string;
  eps_estimate: number | null;
  eps_actual: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
}

function mapRow(r: FinnhubRow): EarningsRow | null {
  if (!r?.symbol || !r?.date) return null;
  return {
    symbol: r.symbol,
    date: r.date,
    eps_estimate: r.epsEstimate ?? null,
    eps_actual: r.epsActual ?? null,
    revenue_estimate: r.revenueEstimate ?? null,
    revenue_actual: r.revenueActual ?? null,
  };
}

export async function fetchEarningsDates(args: JobArgs) {
  requireFinnhub();
  const lookback = Math.min(Math.max(0, Number(args.lookback ?? DEFAULT_LOOKBACK_DAYS)), MAX_TOTAL_DAYS);
  const lookahead = Math.min(Math.max(0, Number(args.lookahead ?? DEFAULT_LOOKAHEAD_DAYS)), MAX_TOTAL_DAYS);
  const startedAt = Date.now();

  const universe = new Set((await query<{ symbol: string }>("SELECT symbol FROM instruments")).map((r) => r.symbol));
  if (universe.size === 0) throw new Error("no symbols in instruments table");

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const windowStart = addDays(today, -lookback);
  const windowEnd = addDays(today, lookahead);

  const chunks: { from: string; to: string }[] = [];
  let cursor = new Date(windowStart);
  while (cursor < windowEnd) {
    const next = addDays(cursor, CHUNK_DAYS);
    const to = next < windowEnd ? next : windowEnd;
    chunks.push({ from: ymd(cursor), to: ymd(to) });
    cursor = addDays(to, 1);
  }

  const allRows: EarningsRow[] = [];
  const fetchFailures: { context: string; error: string }[] = [];
  let rawRowCount = 0;

  for (const c of chunks) {
    try {
      const data = await finnhubFetch(
        withToken(`${FH_BASE}/api/v1/calendar/earnings?from=${c.from}&to=${c.to}`),
        FH_MIN_GAP_MS,
      );
      const rows = Array.isArray(data?.earningsCalendar) ? (data.earningsCalendar as FinnhubRow[]) : [];
      rawRowCount += rows.length;
      for (const r of rows) {
        if (!r?.symbol || !universe.has(r.symbol)) continue;
        const mapped = mapRow(r);
        if (mapped) allRows.push(mapped);
      }
    } catch (e) {
      fetchFailures.push({ context: `sweep ${c.from}..${c.to}`, error: errMsg(e, 200) });
    }
  }

  const fromYmd = ymd(windowStart);
  const toYmd = ymd(windowEnd);
  const covered = new Set(allRows.map((r) => r.symbol));
  const missing = [...universe].filter((s) => !covered.has(s));
  let fallbackHits = 0;
  for (const sym of missing) {
    try {
      const data = await finnhubFetch(
        withToken(`${FH_BASE}/api/v1/calendar/earnings?from=${fromYmd}&to=${toYmd}&symbol=${encodeURIComponent(sym)}`),
        FH_MIN_GAP_MS,
      );
      const rows = Array.isArray(data?.earningsCalendar) ? (data.earningsCalendar as FinnhubRow[]) : [];
      for (const r of rows) {
        // Foreign listings echo back with an exchange suffix (ASML.AS); keep
        // them under the bare universe symbol.
        if (!r?.symbol) continue;
        if (r.symbol !== sym && !r.symbol.startsWith(`${sym}.`)) continue;
        const mapped = mapRow({ ...r, symbol: sym });
        if (mapped) {
          allRows.push(mapped);
          fallbackHits++;
        }
      }
    } catch (e) {
      fetchFailures.push({ context: `fallback ${sym}`, error: errMsg(e, 200) });
    }
  }

  const seen = new Set<string>();
  const unique = allRows.filter((r) => {
    const k = `${r.symbol}|${r.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await bulkUpsert(
    "earnings_dates",
    ["symbol", "date", "eps_estimate", "eps_actual", "revenue_estimate", "revenue_actual"],
    unique,
    ["symbol", "date"],
  );

  return {
    capturedAt: new Date().toISOString(),
    windowStart: fromYmd,
    windowEnd: toYmd,
    chunks: chunks.length,
    rawRowsScanned: rawRowCount,
    fallbackSymbols: missing.length,
    fallbackHits,
    rowsUpserted: unique.length,
    symbolsCovered: new Set(unique.map((r) => r.symbol)).size,
    fetchFailures,
    elapsedMs: Date.now() - startedAt,
  };
}
