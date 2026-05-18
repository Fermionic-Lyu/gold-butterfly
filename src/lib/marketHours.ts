import { useEffect, useState } from "react";
import { insforge } from "./insforge";

interface HolidayRow {
  date: string;             // ET calendar date, YYYY-MM-DD
  name: string;
  early_close_et: string | null; // ET wall-clock close, e.g. "13:00:00"
}

export interface MarketStatus {
  /** True if today is a regular trading day (incl. half-days). */
  isTradingDay: boolean;
  /** Today's open instant (09:30 ET). Null on non-trading days. */
  sessionOpen: Date | null;
  /** Today's close instant. Earlier than 16:00 ET on half-days. */
  sessionClose: Date | null;
  /** True if today closes before 16:00 ET. */
  isEarlyClose: boolean;
  /** True until the holidays fetch resolves. */
  loading: boolean;
}

// Module-level holiday cache. ~12 rows/year × ~2y = ~25 rows; cheap to keep
// the whole upcoming window in memory.
let holidayCache: Map<string, HolidayRow> | null = null;
let inflight: Promise<Map<string, HolidayRow>> | null = null;
const subscribers = new Set<() => void>();

// ET calendar date for a given instant. DST-aware via Intl.
function etDateFor(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}

// Day-of-week for an ET date string (0 = Sunday, 6 = Saturday). Parsing as
// UTC noon dodges TZ edge cases — every weekday name is identical for the
// same calendar date in any timezone the US sits in.
function etDayOfWeek(etDate: string): number {
  return new Date(`${etDate}T12:00:00Z`).getUTCDay();
}

// US Eastern Time offset for a given ET calendar date. DST runs from the
// 2nd Sunday of March through the 1st Sunday of November (rules stable
// since 2007). Returns minutes-from-UTC (always negative).
function etOffsetMinutes(dateStr: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const march1Dow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const dstStartDay = 1 + ((7 - march1Dow) % 7) + 7;  // 2nd Sunday of March
  const nov1Dow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstEndDay = 1 + ((7 - nov1Dow) % 7);          // 1st Sunday of November
  const inDst =
    (month > 3 && month < 11) ||
    (month === 3 && day >= dstStartDay) ||
    (month === 11 && day < dstEndDay);
  return inDst ? -240 : -300;
}

function etWallClockToInstant(dateStr: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const offsetMin = etOffsetMinutes(dateStr);
  const utcMs = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    h,
    m,
    0,
  ) - offsetMin * 60 * 1000;
  return new Date(utcMs);
}

async function loadHolidays(): Promise<Map<string, HolidayRow>> {
  if (holidayCache) return holidayCache;
  if (inflight) return inflight;
  inflight = (async () => {
    // Pull the upcoming window plus a week of history (chart/log surfaces
    // may render past holidays). Small response — no pagination needed.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await insforge.database
      .from("market_holidays")
      .select("date,name,early_close_et")
      .gte("date", since)
      .order("date", { ascending: true })
      .limit(200);
    if (error) {
      inflight = null;
      throw error;
    }
    const map = new Map<string, HolidayRow>();
    for (const r of (data as HolidayRow[]) ?? []) map.set(r.date, r);
    holidayCache = map;
    inflight = null;
    for (const fn of subscribers) fn();
    return map;
  })();
  return inflight;
}

/** Returns today's status if the cache is hydrated, else null. */
function statusFromCache(now: Date): MarketStatus | null {
  if (!holidayCache) return null;
  const today = etDateFor(now);
  const holiday = holidayCache.get(today);
  // Full closure: explicit holiday with no early close, OR weekend.
  const dow = etDayOfWeek(today);
  const isWeekend = dow === 0 || dow === 6;
  if (isWeekend || (holiday && !holiday.early_close_et)) {
    return {
      isTradingDay: false,
      sessionOpen: null,
      sessionClose: null,
      isEarlyClose: false,
      loading: false,
    };
  }
  // Trading day. Half-day if a holiday row exists with an early-close time.
  const sessionOpen = etWallClockToInstant(today, "09:30");
  const closeWall = holiday?.early_close_et?.slice(0, 5) ?? "16:00";
  const sessionClose = etWallClockToInstant(today, closeWall);
  return {
    isTradingDay: true,
    sessionOpen,
    sessionClose,
    isEarlyClose: Boolean(holiday?.early_close_et),
    loading: false,
  };
}

/**
 * Synchronous "should we still be polling for live data" check, designed for
 * use inside setInterval callbacks. Once the holiday cache loads (eagerly on
 * module import, see bottom of file) the answer is authoritative; before
 * that, falls back to a weekday + UTC-hour heuristic.
 */
export function isMarketLive(now: Date = new Date()): boolean {
  const status = statusFromCache(now);
  if (status) {
    if (!status.isTradingDay || !status.sessionOpen || !status.sessionClose) return false;
    const t = now.getTime();
    return t >= status.sessionOpen.getTime() && t <= status.sessionClose.getTime();
  }
  // Cache not yet hydrated — heuristic fallback.
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  const utcHour = now.getUTCHours();
  return utcHour >= 13 && utcHour <= 22;
}

/** Back-compat alias. Prefer `isMarketLive`. */
export const isMarketDataLive = isMarketLive;

/**
 * Subscribe to today's market status. Triggers one shared fetch of the
 * holidays table the first time any component mounts; subsequent subscribers
 * read straight from cache.
 */
export function useMarketStatus(): MarketStatus {
  const [, force] = useState(0);

  useEffect(() => {
    const onChange = () => force((n) => n + 1);
    subscribers.add(onChange);
    void loadHolidays().catch(() => {});
    return () => {
      subscribers.delete(onChange);
    };
  }, []);

  const status = statusFromCache(new Date());
  if (status) return status;
  // Pre-hydration: pessimistic loading state, but use the weekday heuristic
  // for isTradingDay so the UI doesn't flash "Market Closed" on a real
  // session before the fetch resolves.
  const dow = new Date().getUTCDay();
  return {
    isTradingDay: dow !== 0 && dow !== 6,
    sessionOpen: null,
    sessionClose: null,
    isEarlyClose: false,
    loading: true,
  };
}

// Kick off the holiday fetch on first import so polling intervals get
// authoritative answers from their second tick onward. market_holidays is
// anon-readable so this works pre-auth.
void loadHolidays().catch(() => {});
