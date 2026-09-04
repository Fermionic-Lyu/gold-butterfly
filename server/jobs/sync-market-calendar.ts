// Alpaca's trading calendar → market_holidays. Weekdays absent from the
// calendar are closures; days closing before 16:00 are half-days. Only adds
// rows — a seed row with a friendlier name is never overwritten.

import { bulkUpsert } from "../db.ts";
import { ALPACA_TRADING, alpacaFetch, requireAlpaca } from "./shared/alpaca.ts";
import { addDays, ymd } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_LOOKAHEAD_DAYS = 400;
const MAX_TOTAL_DAYS = 1825;

interface AlpacaCalendarRow {
  date: string;
  open: string;
  close: string;
}

export async function syncMarketCalendar(args: JobArgs) {
  requireAlpaca();
  const lookback = Math.min(Math.max(0, Number(args.lookback ?? DEFAULT_LOOKBACK_DAYS)), MAX_TOTAL_DAYS);
  const lookahead = Math.min(Math.max(0, Number(args.lookahead ?? DEFAULT_LOOKAHEAD_DAYS)), MAX_TOTAL_DAYS);
  const startedAt = Date.now();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const windowStart = addDays(today, -lookback);
  const windowEnd = addDays(today, lookahead);

  const tradingDays = (await alpacaFetch(
    `${ALPACA_TRADING}/v2/calendar?start=${ymd(windowStart)}&end=${ymd(windowEnd)}`,
  )) as AlpacaCalendarRow[];
  if (!Array.isArray(tradingDays)) throw new Error("Alpaca calendar response not an array");

  const byDate = new Map<string, AlpacaCalendarRow>();
  for (const row of tradingDays) if (row?.date) byDate.set(row.date, row);

  const holidays: { date: string; name: string; early_close_et: string | null }[] = [];
  for (let cursor = new Date(windowStart); cursor <= windowEnd; cursor = addDays(cursor, 1)) {
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = ymd(cursor);
    const row = byDate.get(date);
    if (!row) {
      holidays.push({ date, name: "Closure (Alpaca-detected)", early_close_et: null });
    } else if (row.close < "16:00") {
      holidays.push({ date, name: "Half-day (Alpaca-detected)", early_close_et: `${row.close}:00` });
    }
  }

  const upserted = await bulkUpsert("market_holidays", ["date", "name", "early_close_et"], holidays, ["date"], {
    update: "none",
  });

  return {
    syncedAt: new Date().toISOString(),
    windowStart: ymd(windowStart),
    windowEnd: ymd(windowEnd),
    alpacaTradingDays: tradingDays.length,
    holidaysDetected: holidays.length,
    upserted,
    elapsedMs: Date.now() - startedAt,
  };
}
