import { queryOne } from "../../db.ts";

// ET calendar date (YYYY-MM-DD), DST-aware — the key every daily job shares.
export function etTodayDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// US equity regular session, 09:30–16:00 ET.
export function isMarketOpen(now: Date = new Date()): { open: boolean; reason?: string; etTime: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = parts.weekday;
  const etTime = `${parts.weekday} ${parts.hour}:${parts.minute} ET`;
  if (weekday === "Sat" || weekday === "Sun") return { open: false, reason: "weekend", etTime };
  const minutes = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  if (minutes < 9 * 60 + 30) return { open: false, reason: "pre-market", etTime };
  if (minutes >= 16 * 60) return { open: false, reason: "after-hours", etTime };
  return { open: true, etTime };
}

// null → a trading day (half-days included); otherwise why the market is shut.
export async function tradingDaySkipReason(runDate: string): Promise<string | null> {
  const dow = new Date(`${runDate}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return "weekend";
  const holiday = await queryOne<{ early_close_et: string | null }>(
    "SELECT early_close_et FROM market_holidays WHERE date = $1",
    [runDate],
  ).catch(() => null);
  if (holiday && holiday.early_close_et === null) return "holiday — full closure";
  return null;
}
