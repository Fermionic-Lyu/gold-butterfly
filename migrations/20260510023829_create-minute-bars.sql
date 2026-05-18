-- minute_bars: per-symbol 1-minute OHLCV bars, refreshed by the
-- fetch-minute-bars scheduler every minute during US market hours. Lets us
-- show ~1-minute-fresh prices in the watchlist drawer and an intraday
-- price chart on the symbol page without each user hitting Alpaca.
--
-- Universe = NDX-100 (same as chain_snapshots), all stored in one batched
-- multi-symbol Alpaca bars call per tick. Older rows can be retained
-- indefinitely cheaply (~40k rows/day, ~10M rows/year, <1GB) so no TTL
-- pruning is wired up here — add later if growth becomes a concern.

CREATE TABLE minute_bars (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC NOT NULL,
  volume BIGINT,
  PRIMARY KEY (symbol, ts)
);

-- Range scans for "last N minutes for symbol X" hit the PK directly, but
-- ts-DESC index speeds the common "latest bar" lookup.
CREATE INDEX idx_minute_bars_symbol_ts_desc ON minute_bars (symbol, ts DESC);

ALTER TABLE minute_bars ENABLE ROW LEVEL SECURITY;

-- Public read: dashboard chart + watchlist drawer for any visitor.
CREATE POLICY "minute_bars_read_all"
  ON minute_bars FOR SELECT
  TO authenticated, anon
  USING (true);

-- Writes are made by the fetch-minute-bars edge function via the service-role API key.
