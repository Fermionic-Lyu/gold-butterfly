-- recompute_hv30_for_ndx: source-of-truth HV30 computation.
--
-- HV30 is the 30-day annualized realized vol used by the dashboard's
-- IV/HV regime card and by the trading-tick worker's vol-view gate.
-- Until now it was computed in fetch-daily-bars from the bars the
-- function happened to fetch *that* invocation — so when the daily cron
-- ran with DEFAULT_LOOKBACK_DAYS=5, every symbol's hv30 got written as
-- NULL (the helper requires ≥11 closes). The DB already stores ~270
-- daily_bars per symbol, so we should just read from that.
--
-- This function:
--   1. Picks the last 31 closes per NDX symbol from daily_bars.
--   2. Computes log returns between consecutive closes.
--   3. Computes the sample stddev of returns and annualizes by sqrt(252).
--   4. Updates instruments.hv30 for every symbol with ≥10 returns.
--
-- Returns one row per updated symbol (so the caller can log how many
-- got refreshed).

CREATE OR REPLACE FUNCTION recompute_hv30_for_ndx()
RETURNS TABLE(symbol text, hv30 numeric)
LANGUAGE sql
AS $$
  WITH ranked AS (
    SELECT
      db.symbol,
      db.date,
      db.close,
      LAG(db.close) OVER (PARTITION BY db.symbol ORDER BY db.date) AS prev_close,
      ROW_NUMBER() OVER (PARTITION BY db.symbol ORDER BY db.date DESC) AS rn
    FROM daily_bars db
    JOIN instruments i
      ON i.symbol = db.symbol AND i.indices @> ARRAY['NDX']
  ),
  log_returns AS (
    SELECT r.symbol, LN(r.close / r.prev_close) AS lr
    FROM ranked r
    WHERE r.rn <= 31 AND r.prev_close IS NOT NULL AND r.prev_close > 0
  ),
  computed AS (
    SELECT
      lr.symbol,
      (STDDEV_SAMP(lr.lr) * SQRT(252))::numeric AS hv
    FROM log_returns lr
    GROUP BY lr.symbol
    HAVING COUNT(*) >= 10
  )
  UPDATE instruments i
  SET hv30 = c.hv
  FROM computed c
  WHERE i.symbol = c.symbol
  RETURNING i.symbol::text, i.hv30;
$$;

GRANT EXECUTE ON FUNCTION recompute_hv30_for_ndx() TO PUBLIC;
