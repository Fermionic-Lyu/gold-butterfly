-- Earnings report dates per company. Populated by the fetch-earnings-dates
-- edge function (FMP earning_calendar). The dashboard reads this to draw
-- vertical markers on the price chart, which makes IV bursts/collapses
-- around earnings legible at a glance.
--
-- Primary key (symbol, date) — a company has at most one ER per calendar
-- day. `time` captures BMO/AMC so the chart can position the marker
-- meaningfully when we eventually plot intraday IV.

CREATE TABLE earnings_dates (
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  date DATE NOT NULL,
  -- 'bmo' = before market open, 'amc' = after market close, 'dmh' = during
  -- market hours, NULL = unspecified by the provider.
  time TEXT CHECK (time IN ('bmo', 'amc', 'dmh')),
  eps_estimate NUMERIC,
  eps_actual NUMERIC,
  revenue_estimate NUMERIC,
  revenue_actual NUMERIC,
  fiscal_period TEXT,
  fiscal_year INTEGER,
  source TEXT NOT NULL DEFAULT 'fmp',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, date)
);

CREATE INDEX idx_earnings_dates_date ON earnings_dates (date);
CREATE INDEX idx_earnings_dates_symbol_date ON earnings_dates (symbol, date DESC);

ALTER TABLE earnings_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "earnings_dates_read_all"
  ON earnings_dates FOR SELECT
  TO authenticated, anon
  USING (true);
