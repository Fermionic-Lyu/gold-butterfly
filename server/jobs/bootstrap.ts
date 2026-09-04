// First-run data fill. Runs at every boot and only does what is missing, so a
// fresh deploy is useful within minutes and setting credentials later just
// needs a restart.

import { hasAlpaca, hasFinnhub } from "../env.ts";
import { queryOne } from "../db.ts";
import type { JobArgs, JobContext } from "./types.ts";

async function isEmpty(table: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return (row?.n ?? 0) === 0;
}

export async function bootstrap(args: JobArgs, ctx: JobContext) {
  if (!hasAlpaca()) return { skipped: true, reason: "alpaca not configured" };
  const force = args.force === true;
  const steps: Record<string, unknown> = {};

  steps["sync-market-calendar"] = await ctx.runJob("sync-market-calendar", {});

  if (force || (await isEmpty("daily_bars"))) {
    steps["fetch-daily-bars"] = await ctx.runJob("fetch-daily-bars", { lookback: 400, force: true });
  }
  if (force || (await isEmpty("chain_underlyings"))) {
    steps["fetch-chains"] = await ctx.runJob("fetch-chains", { force: true, capture_iv: true });
  }
  if (hasFinnhub()) {
    const noFundamentals = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM instruments WHERE market_cap IS NOT NULL",
    );
    if (force || (noFundamentals?.n ?? 0) === 0) steps["fetch-fundamentals"] = await ctx.runJob("fetch-fundamentals", {});
    if (force || (await isEmpty("earnings_dates"))) steps["fetch-earnings-dates"] = await ctx.runJob("fetch-earnings-dates", {});
  }
  if (force || (await isEmpty("company_news"))) {
    steps["scrape-news"] = await ctx.runJob("scrape-news", {});
  }
  return { steps };
}
