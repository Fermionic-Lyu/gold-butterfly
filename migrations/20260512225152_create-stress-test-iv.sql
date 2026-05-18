-- stress_test_iv: dedicated test target for the PostgREST memory-choke
-- reproducer. Isolated from production iv_snapshots so the stress test
-- doesn't pollute the real ATM-IV time series. Shape mirrors iv_snapshots
-- so the derivation logic is identical.
--
-- The stress-test-iv-burst edge function (every 2 min) writes 100 rows
-- here in the OLD broken burst pattern (Promise.all over 20 chunks, no
-- retry, no bounded concurrency). Pair it with chain_snapshots reads to
-- simulate the same pressure the production fetch-chains was hitting.
--
-- Engineers can monitor PostgREST container restarts / OOM-kills while
-- this is firing without any risk to production data.

CREATE TABLE stress_test_iv (
  symbol TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spot NUMERIC,
  atm_iv NUMERIC,
  atm_call_iv NUMERIC,
  atm_put_iv NUMERIC,
  primary_expiration DATE,
  primary_dte INTEGER,
  PRIMARY KEY (symbol, captured_at)
);

CREATE INDEX idx_stress_test_iv_captured ON stress_test_iv (captured_at DESC);

ALTER TABLE stress_test_iv ENABLE ROW LEVEL SECURITY;
-- No public read needed; engineer-only diagnostic table.
