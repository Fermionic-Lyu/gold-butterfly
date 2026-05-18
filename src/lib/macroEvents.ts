// FOMC meeting dates — the second day of each two-day meeting, when the
// rate decision is announced at 14:00 ET. These dates reliably pump ATM IV
// in the days leading up and crush it afterward, especially for index
// trackers (SPY, QQQ) and rate-sensitive sectors.
//
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// The Fed publishes the schedule ~2 years in advance. Refresh this list
// annually when the next year's calendar is posted.

const FOMC_MEETINGS: string[] = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
];

/** Next FOMC announcement on or after `today`, or null if past the published schedule. */
export function nextFomcDate(today: Date = new Date()): string | null {
  const todayStr = today.toISOString().slice(0, 10);
  return FOMC_MEETINGS.find((d) => d >= todayStr) ?? null;
}
