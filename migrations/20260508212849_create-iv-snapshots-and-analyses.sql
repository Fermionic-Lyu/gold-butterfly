-- iv_snapshots: append-only time series of ATM IV for the MAG-7. Filled by the
-- snapshot-iv-mag7 edge function on a schedule during US market hours so the
-- frontend can compute true IV rank without paying for a historical-IV feed.
CREATE TABLE iv_snapshots (
  symbol TEXT NOT NULL CHECK (symbol IN ('AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spot NUMERIC,
  atm_iv NUMERIC,
  atm_call_iv NUMERIC,
  atm_put_iv NUMERIC,
  primary_expiration DATE,
  primary_dte INTEGER,
  hv30 NUMERIC,
  PRIMARY KEY (symbol, captured_at)
);

CREATE INDEX idx_iv_snapshots_symbol_time ON iv_snapshots (symbol, captured_at DESC);

ALTER TABLE iv_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "iv_snapshots_read_all"
  ON iv_snapshots FOR SELECT
  TO authenticated, anon
  USING (true);

-- strategy_analyses: per-user history of AI strategy reports so users can revisit
-- past recommendations alongside the snapshot they were generated from.
CREATE TABLE strategy_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  analysis JSONB NOT NULL,
  model TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_strategy_analyses_user_symbol_time
  ON strategy_analyses (user_id, symbol, generated_at DESC);

ALTER TABLE strategy_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "strategy_analyses_select_own"
  ON strategy_analyses FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "strategy_analyses_insert_own"
  ON strategy_analyses FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "strategy_analyses_delete_own"
  ON strategy_analyses FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
