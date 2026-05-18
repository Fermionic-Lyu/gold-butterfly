-- stress_test_chain: dedicated isolated target for the PostgREST OOM
-- reproducer. Schema mirrors chain_snapshots (jsonb payload + symbol PK)
-- so the write pattern produced by the stress-test-chain-burst edge
-- function is byte-for-byte the same as what production fetch-chains
-- used to hit. Engineers can correlate PostgREST container restarts /
-- 503s / schema-cache reloads with the 2-minute burst cadence here
-- without any risk to production chain_snapshots.
--
-- Replaces the earlier stress_test_iv setup, which was the wrong
-- failure mode (small-row writes don't reproduce the JSONB choke).

CREATE TABLE stress_test_chain (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stress_test_chain ENABLE ROW LEVEL SECURITY;
-- Engineer-only diagnostic table; no public read policy.
