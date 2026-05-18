-- agent_tick_applied: per-(agent, run_date) lease for apply_agent_tick.
--
-- Why: when a trading-tick run fails mid-flight (gateway 502, isolate
-- killed) AND the retry-backstop fires later, both runs could call
-- apply_agent_tick concurrently. The RPC inserts new positions, updates
-- agents.cash, and inserts an equity_snapshot — all of which would be
-- duplicated if two invocations succeeded for the same (agent, day).
-- The decisions table already has a unique index that dedupes decision
-- rows, but positions / cash / equity have no such protection.
--
-- This table is the single source of truth for "has apply_agent_tick
-- already committed mutations for (agent, run_date)?" — a row exists
-- iff yes. The PK is the lease; apply_agent_tick INSERT ON CONFLICT
-- DO NOTHING acquires it atomically. If the insert hits the conflict,
-- the RPC returns early without touching any other table.
--
-- The lease is acquired INSIDE the apply_agent_tick transaction, so on
-- rollback (any error during commits) the lease releases automatically
-- and a subsequent retry can re-acquire it.

CREATE TABLE IF NOT EXISTS agent_tick_applied (
  agent_id   uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_date   date        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, run_date)
);

-- Backfill from agent_runs so any retry against a historically-'done'
-- run is blocked too. (At time of writing the 5/12 + 5/13 done runs
-- are the only ones, but make it general.)
INSERT INTO agent_tick_applied (agent_id, run_date, applied_at)
SELECT a.id, ar.run_date, COALESCE(ar.finished_at, ar.started_at, now())
FROM agent_runs ar
JOIN agents a ON a.slug = ar.agent_slug
WHERE ar.status = 'done'
ON CONFLICT (agent_id, run_date) DO NOTHING;
