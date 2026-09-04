// Latest 1-minute bars for every tracked instrument → minute_bars. One batched
// Alpaca call per tick; a 5-minute lookback lets a missed tick self-heal.

import { bulkUpsert } from "../db.ts";
import { fetchBars, requireAlpaca } from "./shared/alpaca.ts";
import { etTodayDate, isMarketOpen, tradingDaySkipReason } from "./shared/market-time.ts";
import { pickSymbols, trackedSymbols } from "./shared/universe.ts";
import type { JobArgs } from "./types.ts";

const LOOKBACK_MINUTES = 5;
export const BAR_COLUMNS = ["symbol", "ts", "open", "high", "low", "close", "volume"];

export async function fetchMinuteBars(args: JobArgs) {
  requireAlpaca();
  const force = args.force === true;
  const market = isMarketOpen();
  if (!market.open && !force) return { skipped: true, reason: market.reason, etTime: market.etTime };
  if (!force) {
    const reason = await tradingDaySkipReason(etTodayDate());
    if (reason) return { skipped: true, reason };
  }

  const startedAt = Date.now();
  const { symbols } = pickSymbols(await trackedSymbols(), args.symbols);
  if (symbols.length === 0) throw new Error("no tracked symbols in instruments table");

  // IEX lags ~15s; trailing `end` by 90s stays inside what is published.
  const end = new Date(Date.now() - 90_000);
  const start = new Date(end.getTime() - LOOKBACK_MINUTES * 60_000);
  const bars = await fetchBars(symbols, "1Min", start.toISOString(), end.toISOString(), {
    adjustment: "raw",
    maxPages: 8,
  });
  await bulkUpsert("minute_bars", BAR_COLUMNS, bars, ["symbol", "ts"]);

  return {
    capturedAt: new Date().toISOString(),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    symbolsRequested: symbols.length,
    barsStored: bars.length,
    elapsedMs: Date.now() - startedAt,
  };
}
