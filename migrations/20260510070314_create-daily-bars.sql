-- daily_bars: per-symbol end-of-day OHLCV bars, refreshed by the
-- fetch-daily-bars scheduler once per day after the US equity close.
-- Powers the PriceChart 1M/3M/6M/1Y ranges and the WatchlistDrawer's
-- previous-close price (paired with minute_bars for the current price).
-- Replaces on-demand Alpaca calls from the dashboard.
--
-- Universe = NDX-100 (same as chain_snapshots and minute_bars). At
-- ~252 trading days/yr × 100 symbols ≈ 25k rows/yr — trivial to retain
-- indefinitely.

CREATE TABLE daily_bars (
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC NOT NULL,
  volume BIGINT,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX idx_daily_bars_symbol_date_desc ON daily_bars (symbol, date DESC);

ALTER TABLE daily_bars ENABLE ROW LEVEL SECURITY;

-- Public read: PriceChart + WatchlistDrawer for any visitor.
CREATE POLICY "daily_bars_read_all"
  ON daily_bars FOR SELECT
  TO authenticated, anon
  USING (true);

-- Writes are made by the fetch-daily-bars edge function via the service-role API key.
