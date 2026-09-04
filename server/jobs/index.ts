// Job registry, runner, and the in-process scheduler.
//
// Schedules are cron expressions in America/New_York, so market-hour windows
// are written as wall-clock ET and DST takes care of itself. Every run takes a
// Postgres advisory lock keyed on the job name, so overlapping fires (a slow
// chain refresh, a backstop firing while the primary is still running) skip
// instead of stacking.

import cron, { type ScheduledTask } from "node-cron";
import { credentialStatus } from "../env.ts";
import { execute, pool, queryOne } from "../db.ts";
import { errMsg } from "./shared/util.ts";
import type { JobArgs, JobDef, RunOutcome } from "./types.ts";
import { analyzeNews } from "./analyze-news.ts";
import { backfillMinuteBars } from "./backfill-minute-bars.ts";
import { bootstrap } from "./bootstrap.ts";
import { fetchChains } from "./fetch-chains.ts";
import { fetchDailyBars } from "./fetch-daily-bars.ts";
import { fetchEarningsDates } from "./fetch-earnings-dates.ts";
import { fetchFundamentals } from "./fetch-fundamentals.ts";
import { fetchMinuteBars } from "./fetch-minute-bars.ts";
import { scrapeNews } from "./scrape-news.ts";
import { snapshotChainEod } from "./snapshot-chain-eod.ts";
import { syncMarketCalendar } from "./sync-market-calendar.ts";
import { tradingTick } from "./trading-tick.ts";

const TZ = "America/New_York";

export const JOBS: JobDef[] = [
  {
    name: "fetch-minute-bars",
    description: "1-minute bars for the NDX-100 during the session",
    schedules: ["* 9-16 * * 1-5"],
    requires: ["alpaca"],
    run: fetchMinuteBars,
  },
  {
    name: "fetch-chains",
    description: "Full option chains (+ ATM IV sample on the half-hour)",
    schedules: ["*/2 9-16 * * 1-5"],
    requires: ["alpaca"],
    run: fetchChains,
  },
  {
    name: "fetch-daily-bars",
    description: "Daily OHLCV + HV30 recompute after the close",
    schedules: ["0 18 * * 1-5"],
    requires: ["alpaca"],
    run: fetchDailyBars,
  },
  {
    name: "snapshot-chain-eod",
    description: "Archive the closing chain into the history tables",
    schedules: ["5 18 * * 1-5"],
    requires: [],
    run: snapshotChainEod,
  },
  {
    name: "trading-tick",
    description: "Run every active agent's daily decision (primary + backstop)",
    schedules: ["10 18 * * 1-5", "50 18 * * 1-5"],
    requires: ["alpaca", "openrouter"],
    run: tradingTick,
  },
  {
    name: "fetch-earnings-dates",
    description: "Upcoming earnings dates from Finnhub",
    schedules: ["0 19 * * *"],
    requires: ["finnhub"],
    run: (args) => fetchEarningsDates({ lookback: 0, lookahead: 95, ...args }),
  },
  {
    name: "fetch-fundamentals",
    description: "Market cap and P/E from Finnhub",
    schedules: ["0 22 * * *"],
    requires: ["finnhub"],
    run: fetchFundamentals,
  },
  {
    name: "scrape-news",
    description: "Daily headlines for every instrument, then the AI digest",
    schedules: ["30 4 * * *"],
    requires: ["alpaca"],
    run: scrapeNews,
  },
  {
    name: "analyze-news",
    description: "AI digest of today's news for subscribed symbols (backstop)",
    schedules: ["30 5 * * *"],
    requires: ["openrouter"],
    run: analyzeNews,
  },
  {
    name: "sync-market-calendar",
    description: "Holidays and half-days from Alpaca's trading calendar",
    schedules: ["0 4 * * 1"],
    requires: ["alpaca"],
    run: (args) => syncMarketCalendar({ lookback: 365, lookahead: 400, ...args }),
  },
  {
    name: "backfill-minute-bars",
    description: "Manual gap-fill of minute_bars for an explicit window",
    schedules: [],
    requires: ["alpaca"],
    run: backfillMinuteBars,
  },
  {
    name: "bootstrap",
    description: "Seed market data that is missing (runs at boot)",
    schedules: [],
    requires: ["alpaca"],
    run: bootstrap,
  },
];

const byName = new Map(JOBS.map((j) => [j.name, j]));
export const getJob = (name: string) => byName.get(name);

const active = new Map<string, { runId: number; startedAt: Date; trigger: string }>();
export const activeRuns = () => [...active.entries()].map(([job, v]) => ({ job, ...v }));

export async function runJob(name: string, args: JobArgs = {}, trigger = "manual"): Promise<RunOutcome> {
  const def = byName.get(name);
  if (!def) throw new Error(`unknown job: ${name}`);

  const creds = credentialStatus();
  const missing = def.requires.filter((c) => !creds[c]);
  if (missing.length > 0) {
    const reason = `missing credentials: ${missing.join(", ")}`;
    const runId = await recordSkipped(name, trigger, args, reason);
    return { runId, status: "skipped", result: { skipped: true, reason } };
  }

  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name]);
    locked = lock.rows[0]?.ok === true;
    if (!locked) {
      const reason = "already running";
      const runId = await recordSkipped(name, trigger, args, reason);
      return { runId, status: "skipped", result: { skipped: true, reason } };
    }

    const started = await queryOne<{ id: number }>(
      "INSERT INTO job_runs (job, trigger, status, args) VALUES ($1, $2, 'running', $3::jsonb) RETURNING id",
      [name, trigger, JSON.stringify(args)],
    );
    const runId = started?.id ?? null;
    if (runId !== null) active.set(name, { runId, startedAt: new Date(), trigger });
    console.log(`[job] ${name} start (${trigger}) run=${runId}`);
    const ctx = { trigger, runJob: (n: string, a: JobArgs = {}) => runJob(n, a, `chain:${name}`) };
    try {
      const result = await def.run(args, ctx);
      await execute("UPDATE job_runs SET status = 'done', result = $2::jsonb, finished_at = now() WHERE id = $1", [
        runId,
        JSON.stringify(result ?? null),
      ]);
      console.log(`[job] ${name} done run=${runId} ${summarize(result)}`);
      return { runId, status: "done", result };
    } catch (e) {
      const error = errMsg(e, 2000);
      await execute("UPDATE job_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1", [runId, error]);
      console.error(`[job] ${name} error run=${runId}: ${error}`);
      return { runId, status: "error", error };
    } finally {
      active.delete(name);
    }
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => {});
    lockClient.release();
  }
}

async function recordSkipped(name: string, trigger: string, args: JobArgs, reason: string): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO job_runs (job, trigger, status, args, result, finished_at)
     VALUES ($1, $2, 'skipped', $3::jsonb, $4::jsonb, now()) RETURNING id`,
    [name, trigger, JSON.stringify(args), JSON.stringify({ skipped: true, reason })],
  ).catch(() => null);
  return row?.id ?? null;
}

function summarize(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (r.skipped) return `skipped: ${r.reason ?? ""}`;
  const keys = ["barsStored", "quoteRowsStored", "symbolsAnalyzed", "articlesWritten", "dispatched", "rowsUpserted", "upserted", "elapsedMs"];
  return keys.filter((k) => k in r).map((k) => `${k}=${r[k]}`).join(" ");
}

// ---------- scheduler ----------

const tasks: ScheduledTask[] = [];

export function startScheduler() {
  for (const def of JOBS) {
    def.schedules.forEach((expr, i) => {
      const task = cron.schedule(
        expr,
        () => {
          runJob(def.name, {}, "schedule").catch((e) => console.error(`[cron] ${def.name}: ${errMsg(e)}`));
        },
        { timezone: TZ, name: `${def.name}#${i}` },
      );
      tasks.push(task);
    });
  }
  // Keep the ops table bounded.
  tasks.push(
    cron.schedule(
      "15 3 * * *",
      () => {
        execute(
          "DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY started_at DESC LIMIT 3000)",
        ).catch(() => {});
      },
      { timezone: TZ, name: "prune-job-runs" },
    ),
  );
  console.log(`[cron] scheduled ${tasks.length} tasks (${TZ})`);
}

export async function stopScheduler() {
  await Promise.all(tasks.map((t) => Promise.resolve(t.stop()).catch(() => {})));
  tasks.length = 0;
}

export function scheduleSummary() {
  return JOBS.map((j) => ({
    name: j.name,
    description: j.description,
    schedules: j.schedules,
    timezone: TZ,
    requires: j.requires,
  }));
}
