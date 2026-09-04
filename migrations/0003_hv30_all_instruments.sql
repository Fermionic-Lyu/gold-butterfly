-- HV30 for every tracked instrument, not only Nasdaq-100 members.
DROP FUNCTION IF EXISTS recompute_hv30_for_ndx();

CREATE OR REPLACE FUNCTION recompute_hv30()
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
    JOIN instruments i ON i.symbol = db.symbol
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
