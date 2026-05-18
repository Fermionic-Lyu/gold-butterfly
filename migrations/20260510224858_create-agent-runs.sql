-- agent_runs: durable per-agent per-day execution status. Powers idempotent
-- retries of the daily trading-tick coordinator and gives the dashboard a
-- queryable record of "did agent X actually finish today?".
--
-- Flow:
--   coordinator dispatch  → UPSERT (status='pending', dispatched_at=NOW())
--   worker entry          → UPDATE (status='running',  started_at=NOW())
--   worker success        → UPDATE (status='done',     finished_at=NOW())
--   worker failure        → UPDATE (status='error',    finished_at=NOW(), error=...)
--
-- The coordinator re-reads this table on every invocation and only fires
-- workers for agents that aren't already 'done' for today's date. So a
-- partial failure is auto-recoverable just by re-invoking the coordinator.

CREATE TABLE agent_runs (
  run_date DATE NOT NULL,
  agent_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'error')),
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (run_date, agent_slug)
);

-- Reverse lookup for the dashboard ("what ran today, sorted by agent").
CREATE INDEX idx_agent_runs_date_desc ON agent_runs (run_date DESC, agent_slug);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_runs_read_all"
  ON agent_runs FOR SELECT
  TO authenticated, anon
  USING (true);

-- Writes are made by the trading-tick coordinator and process-agent worker
-- via the service-role API key.
