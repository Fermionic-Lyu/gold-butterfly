// Archive the live chain into the *_history tables under today's ET date.

import { queryOne } from "../db.ts";
import { etTodayDate, tradingDaySkipReason } from "./shared/market-time.ts";
import type { JobArgs } from "./types.ts";

export async function snapshotChainEod(args: JobArgs) {
  const startedAt = Date.now();
  const runDate = typeof args.run_date === "string" ? args.run_date : etTodayDate();
  if (args.force !== true) {
    const reason = await tradingDaySkipReason(runDate);
    if (reason) return { skipped: true, reason, runDate };
  }
  const row = await queryOne<{ result: unknown }>("SELECT archive_chain_eod($1::date) AS result", [runDate]);
  return { runDate, archived: row?.result ?? null, elapsedMs: Date.now() - startedAt };
}
