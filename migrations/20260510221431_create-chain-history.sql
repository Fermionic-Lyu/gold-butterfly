-- chain_history: append-only end-of-day snapshots of the full option chain
-- per symbol per trading day. Powers backtesting of daily-rebalance
-- strategies — agents (and future research code) can replay decisions
-- against the same chain state they would have seen at the close.
--
-- chain_snapshots stays as the live, overwrite-only "what's current"
-- table. This one is its historical companion, populated post-close by
-- the snapshot-chain-eod edge function. Each row's payload mirrors the
-- chain_snapshots payload shape so consumers can use the same code path.
--
-- Storage: ~7-8 MB per trading day (100 symbols × ~77 KB pglz'd JSONB)
-- ≈ ~2 GB/year. Fine to retain indefinitely.

CREATE TABLE chain_history (
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  payload JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, date)
);

CREATE INDEX idx_chain_history_date ON chain_history (date DESC);

ALTER TABLE chain_history ENABLE ROW LEVEL SECURITY;

-- Public read for backtesting tooling + future dashboard surfaces.
CREATE POLICY "chain_history_read_all"
  ON chain_history FOR SELECT
  TO authenticated, anon
  USING (true);

-- Writes are made by the snapshot-chain-eod edge function via service-role.
