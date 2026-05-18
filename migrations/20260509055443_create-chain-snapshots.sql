-- chain_snapshots: latest options-chain payload per symbol, refreshed by the
-- fetch-chains scheduler every minute during US market hours. Consumers
-- (dashboard `options-chain` function, agents' `trading-tick`) read from
-- here instead of hitting Alpaca directly, so we get one upstream fetch per
-- symbol per minute regardless of how many users or agents are interested.
--
-- Symbol set is the Nasdaq-100 (~100 symbols), well within Alpaca's
-- 200/minute free-tier limit. Symbols outside the set fall back to a live
-- fetch in the consumer functions.

CREATE TABLE chain_snapshots (
  symbol TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chain_snapshots_fetched_at ON chain_snapshots (fetched_at DESC);

ALTER TABLE chain_snapshots ENABLE ROW LEVEL SECURITY;

-- Public read: dashboard + trading-tick + any signed-in user reading via SDK.
CREATE POLICY "chain_snapshots_read_all"
  ON chain_snapshots FOR SELECT
  TO authenticated, anon
  USING (true);

-- Writes are made by the fetch-chains edge function via the service-role API key.
