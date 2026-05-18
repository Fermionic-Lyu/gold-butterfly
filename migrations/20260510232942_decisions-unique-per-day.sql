-- Add an explicit run_date column to decisions so we can enforce
-- "at most one decision per (agent, symbol) per trading day" at the DB
-- level. Required to make retries truly idempotent — even if the worker
-- gets fired twice for the same agent on the same day (due to a crash
-- mid-execution and a subsequent retry), only the first decision row per
-- symbol survives.
--
-- run_date is the ET calendar date the decision belongs to, computed by
-- the worker from the coordinator-passed run_date. Decoupled from
-- decided_at (which is wall-clock timestamp) so we don't depend on
-- timezone math at query time.

ALTER TABLE decisions ADD COLUMN run_date DATE;

-- Backfill from existing decided_at values, interpreting in ET. Existing
-- rows (currently 0) are handled, and future inserts must populate.
UPDATE decisions
   SET run_date = (decided_at AT TIME ZONE 'America/New_York')::date
 WHERE run_date IS NULL;

ALTER TABLE decisions ALTER COLUMN run_date SET NOT NULL;

-- The unique index. ON CONFLICT (agent_id, symbol, run_date) DO NOTHING
-- on insert makes worker retries safe.
CREATE UNIQUE INDEX decisions_unique_per_day
  ON decisions (agent_id, symbol, run_date);
