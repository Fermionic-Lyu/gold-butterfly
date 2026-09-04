// Daily OHLCV for every tracked instrument → daily_bars, then HV30 recomputed from the
// table. `lookback` (calendar days) turns the same job into a backfill;
// `symbols` narrows it to newly added instruments.

import { bulkUpsert, query } from "../db.ts";
import { fetchBars, requireAlpaca } from "./shared/alpaca.ts";
import { etTodayDate, tradingDaySkipReason } from "./shared/market-time.ts";
import { pickSymbols, trackedSymbols } from "./shared/universe.ts";
import type { JobArgs } from "./types.ts";

const DEFAULT_LOOKBACK_DAYS = 5;
const MAX_LOOKBACK_DAYS = 1825;

export async function fetchDailyBars(args: JobArgs) {
  requireAlpaca();
  const force = args.force === true;
  const lookback = Math.min(Math.max(1, Number(args.lookback ?? DEFAULT_LOOKBACK_DAYS)), MAX_LOOKBACK_DAYS);
  if (!force) {
    const reason = await tradingDaySkipReason(etTodayDate());
    if (reason) return { skipped: true, reason };
  }

  const startedAt = Date.now();
  const { symbols } = pickSymbols(await trackedSymbols(), args.symbols);
  if (symbols.length === 0) throw new Error("no tracked symbols in instruments table");

  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - lookback);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const bars = await fetchBars(symbols, "1Day", startDate, endDate, { adjustment: "split", maxPages: 200 });
  const rows = bars.map((b) => ({
    symbol: b.symbol,
    date: b.ts.slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  await bulkUpsert("daily_bars", ["symbol", "date", "open", "high", "low", "close", "volume"], rows, [
    "symbol",
    "date",
  ]);

  const hv = await query("SELECT * FROM recompute_hv30()");

  return {
    capturedAt: new Date().toISOString(),
    windowStart: startDate,
    windowEnd: endDate,
    lookbackDays: lookback,
    symbolsRequested: symbols.length,
    barsStored: rows.length,
    hv30Updated: hv.length,
    elapsedMs: Date.now() - startedAt,
  };
}
