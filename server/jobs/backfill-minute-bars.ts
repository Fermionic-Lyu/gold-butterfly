// Manual gap-fill for minute_bars over an explicit window.
//   args: { start: ISO (inclusive), end: ISO (exclusive) }

import { bulkUpsert } from "../db.ts";
import { fetchBars, requireAlpaca } from "./shared/alpaca.ts";
import { ndxSymbols } from "./shared/universe.ts";
import { BAR_COLUMNS } from "./fetch-minute-bars.ts";
import type { JobArgs } from "./types.ts";

export async function backfillMinuteBars(args: JobArgs) {
  requireAlpaca();
  const start = new Date(String(args.start ?? ""));
  const end = new Date(String(args.end ?? ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("args must include start and end (ISO timestamps, end > start)");
  }
  const startedAt = Date.now();
  const symbols = await ndxSymbols();
  const bars = await fetchBars(symbols, "1Min", start.toISOString(), end.toISOString(), {
    adjustment: "raw",
    maxPages: 50,
  });
  await bulkUpsert("minute_bars", BAR_COLUMNS, bars, ["symbol", "ts"]);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    symbolsRequested: symbols.length,
    barsStored: bars.length,
    elapsedMs: Date.now() - startedAt,
  };
}
