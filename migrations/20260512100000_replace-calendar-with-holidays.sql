-- Replace market_calendar (one row per *trading* day, sourced from Alpaca)
-- with market_holidays (one row per *exception*, statically seeded). The
-- default rule "US equity markets open Mon-Fri" handles 250+ days/year on
-- its own; we only need to record the ~12 days that deviate.
--
-- A row in market_holidays means today is NOT a regular full trading day:
--   early_close_et IS NULL    → market fully closed (weekend rules apply on
--                              top — but every holiday already falls on a
--                              weekday-observed date, otherwise it wouldn't
--                              be listed)
--   early_close_et IS NOT NULL → market opens normally but closes at this
--                               ET wall-clock time (typically '13:00' on
--                               day-after-Thanksgiving and Christmas Eve)

DROP TABLE IF EXISTS market_calendar;

CREATE TABLE market_holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  early_close_et TIME
);

ALTER TABLE market_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_holidays_read_all"
  ON market_holidays FOR SELECT
  TO authenticated, anon
  USING (true);

-- Seed two calendar years. NYSE publishes the schedule 2-3 years ahead, so
-- this can be extended via a follow-up migration when 2028 is posted.
-- Source: nyse.com/markets/hours-calendars
INSERT INTO market_holidays (date, name, early_close_et) VALUES
  ('2026-01-01', 'New Year''s Day',              NULL),
  ('2026-01-19', 'Martin Luther King, Jr. Day',  NULL),
  ('2026-02-16', 'Washington''s Birthday',       NULL),
  ('2026-04-03', 'Good Friday',                  NULL),
  ('2026-05-25', 'Memorial Day',                 NULL),
  ('2026-06-19', 'Juneteenth',                   NULL),
  ('2026-07-03', 'Independence Day (observed)',  NULL),
  ('2026-09-07', 'Labor Day',                    NULL),
  ('2026-11-26', 'Thanksgiving Day',             NULL),
  ('2026-11-27', 'Day After Thanksgiving',       '13:00'),
  ('2026-12-24', 'Christmas Eve',                '13:00'),
  ('2026-12-25', 'Christmas Day',                NULL),
  ('2027-01-01', 'New Year''s Day',              NULL),
  ('2027-01-18', 'Martin Luther King, Jr. Day',  NULL),
  ('2027-02-15', 'Washington''s Birthday',       NULL),
  ('2027-03-26', 'Good Friday',                  NULL),
  ('2027-05-31', 'Memorial Day',                 NULL),
  ('2027-06-18', 'Juneteenth (observed)',        NULL),
  ('2027-07-05', 'Independence Day (observed)',  NULL),
  ('2027-09-06', 'Labor Day',                    NULL),
  ('2027-11-25', 'Thanksgiving Day',             NULL),
  ('2027-11-26', 'Day After Thanksgiving',       '13:00'),
  ('2027-12-24', 'Christmas Day (observed)',     NULL);
