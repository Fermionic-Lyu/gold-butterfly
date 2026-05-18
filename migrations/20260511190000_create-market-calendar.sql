-- Source of truth for US equity trading days. Populated by the
-- sync-market-calendar edge function from Alpaca's /v2/calendar endpoint.
--
-- Only trading days have rows. Absence of a row ⇒ market closed
-- (weekend or holiday). This lets edge functions and the frontend gate
-- on a single SELECT instead of inferring from data-freshness heuristics.
--
-- session_open / session_close are absolute timestamps for the regular
-- session bell-to-bell on that date. is_early_close is the derived flag
-- for half-days (typically day-after-Thanksgiving and Christmas Eve, which
-- close at 13:00 ET).

CREATE TABLE market_calendar (
  date DATE PRIMARY KEY,
  session_open TIMESTAMPTZ NOT NULL,
  session_close TIMESTAMPTZ NOT NULL,
  is_early_close BOOLEAN NOT NULL DEFAULT false,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_market_calendar_date_desc ON market_calendar (date DESC);

ALTER TABLE market_calendar ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_calendar_read_all"
  ON market_calendar FOR SELECT
  TO authenticated, anon
  USING (true);
