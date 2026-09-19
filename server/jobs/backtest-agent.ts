// Replays one agent over the archived closes in chain_quotes_history, one
// session at a time, through the same Phase A/B path a live tick uses. Each day
// commits via apply_agent_tick, so a late-added agent ends up with the same
// ledger, decisions and equity curve it would have had trading all along.
//
//   args: { slug: string, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", dry_run?: boolean }

import { query, queryOne } from "../db.ts";
import { createPostHog } from "./shared/posthog.ts";
import { errMsg } from "./shared/util.ts";
import { clockFor, runAgentWithStatus, type AgentRow } from "./trading-tick.ts";
import type { JobArgs } from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown, fallback: string) => (DATE_RE.test(String(v ?? "")) ? String(v) : fallback);

export async function backtestAgent(args: JobArgs) {
  const slug = String(args.slug ?? "");
  if (!slug) throw new Error("backtest-agent needs a slug");
  const dryRun = args.dry_run === true;
  const startedAt = Date.now();

  const agent = await queryOne<AgentRow>("SELECT * FROM agents WHERE slug = $1", [slug]);
  if (!agent) throw new Error(`no agent with slug ${slug}`);

  const from = asDate(args.from, "0001-01-01");
  const to = asDate(args.to, "9999-12-31");
  // Only sessions archived for this agent's own universe can be replayed.
  const sessions = await query<{ date: string }>(
    `SELECT DISTINCT date::text AS date
       FROM chain_underlyings_history
      WHERE symbol = ANY($1) AND spot IS NOT NULL AND date BETWEEN $2::date AND $3::date
      ORDER BY date ASC`,
    [agent.watched_symbols, from, to],
  );
  if (sessions.length === 0) {
    return { slug, skipped: true, reason: "no archived sessions in range", from, to };
  }

  const posthog = createPostHog();
  const days: unknown[] = [];
  try {
    for (const { date } of sessions) {
      // Cash and open positions advance day to day, so re-read rather than
      // reusing the row loaded before the loop.
      const current = await queryOne<AgentRow>("SELECT * FROM agents WHERE id = $1", [agent.id]);
      if (!current) throw new Error(`agent ${slug} disappeared mid-replay`);

      const outcome = await runAgentWithStatus(current, clockFor(date, true), dryRun, posthog);
      if (!outcome.ok) {
        days.push({ date, ok: false, error: outcome.error });
        // A failed session leaves the ledger short of that day; continuing would
        // compound the gap into every later day.
        break;
      }
      const r = outcome.result as Record<string, any>;
      const applied = r?.applied as Record<string, unknown> | undefined;
      days.push({
        date,
        ok: true,
        cash: Math.round(Number(r?.cash ?? 0)),
        total_equity: Math.round(Number(r?.total_equity ?? 0)),
        open_positions: r?.open_positions ?? 0,
        opens: applied?.opens ?? 0,
        closes: applied?.closes ?? 0,
        expires: applied?.expires ?? 0,
        skipped: applied?.reason ?? null,
        actions: (r?.actions ?? []) as unknown[],
      });
    }
  } catch (e) {
    days.push({ error: errMsg(e, 500) });
  } finally {
    await posthog?.shutdown().catch(() => {});
  }

  const last = [...days].reverse().find((d) => (d as any)?.ok) as Record<string, unknown> | undefined;
  return {
    slug,
    dryRun,
    sessions: sessions.length,
    replayed: days.filter((d) => (d as any)?.ok).length,
    from: sessions[0].date,
    to: sessions[sessions.length - 1].date,
    final_equity: last?.total_equity ?? null,
    elapsedMs: Date.now() - startedAt,
    days,
  };
}
