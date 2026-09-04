// Data fill that runs at every boot and only does what is missing: the whole
// universe on a fresh database, and just the newly seeded symbols after that.
// Setting credentials later needs nothing more than a restart.

import { hasAlpaca, hasFinnhub } from "../env.ts";
import { query, queryOne } from "../db.ts";
import type { JobArgs, JobContext } from "./types.ts";

async function isEmpty(table: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return (row?.n ?? 0) === 0;
}

// Tracked symbols with no row at all in `table` (keyed by `column`).
async function symbolsMissingFrom(table: string, column: string): Promise<string[]> {
  const rows = await query<{ symbol: string }>(
    `SELECT i.symbol FROM instruments i
      WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.${column} = i.symbol)
      ORDER BY i.symbol`,
  );
  return rows.map((r) => r.symbol);
}

export async function bootstrap(args: JobArgs, ctx: JobContext) {
  if (!hasAlpaca()) return { skipped: true, reason: "alpaca not configured" };
  const force = args.force === true;
  const steps: Record<string, unknown> = {};

  steps["sync-market-calendar"] = await ctx.runJob("sync-market-calendar", {});

  if (force || (await isEmpty("daily_bars"))) {
    steps["fetch-daily-bars"] = await ctx.runJob("fetch-daily-bars", { lookback: 400, force: true });
  } else {
    const missing = await symbolsMissingFrom("daily_bars", "symbol");
    if (missing.length) {
      steps["fetch-daily-bars:new"] = await ctx.runJob("fetch-daily-bars", { symbols: missing, lookback: 400, force: true });
    }
  }

  if (force || (await isEmpty("chain_underlyings"))) {
    steps["fetch-chains"] = await ctx.runJob("fetch-chains", { force: true, capture_iv: true });
  } else {
    const missing = await symbolsMissingFrom("chain_underlyings", "symbol");
    if (missing.length) steps["fetch-chains:new"] = await ctx.runJob("fetch-chains", { symbols: missing, force: true });
  }

  if (hasFinnhub()) {
    const withFundamentals = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM instruments WHERE market_cap IS NOT NULL",
    );
    if (force || (withFundamentals?.n ?? 0) === 0) steps["fetch-fundamentals"] = await ctx.runJob("fetch-fundamentals", {});
    if (force || (await isEmpty("earnings_dates"))) steps["fetch-earnings-dates"] = await ctx.runJob("fetch-earnings-dates", {});
  }

  if (force || (await isEmpty("company_news"))) {
    steps["scrape-news"] = await ctx.runJob("scrape-news", {});
  } else {
    const missing = await symbolsMissingFrom("company_news", "symbol");
    if (missing.length) steps["scrape-news:new"] = await ctx.runJob("scrape-news", { symbols: missing, analyze: false });
  }
  return { steps };
}
