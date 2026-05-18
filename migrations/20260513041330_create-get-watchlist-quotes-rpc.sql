-- get_watchlist_quotes: per-symbol price + prev_close for the watchlist
-- drawer in one round trip.
--
-- Replaces the client-side composition of latest minute_bars + last two
-- daily_bars, which had two issues:
--   1. It compared the daily bar's date against `new Date().toISOString()`
--      (UTC). After the daily cron has run post-close, the daily bar's
--      date is the ET trading date — which differs from UTC date during
--      the late-evening window. The mismatch made the code pick the
--      latest daily AS prev_close, so change = price − price = 0.
--   2. It used a 10-minute minute_bars lookback. Outside the session
--      that returns nothing → fallback to latestDaily for both sides →
--      same 0-change failure.
--
-- The function picks the canonical "today's price" by trading-session
-- semantics:
--   - If the latest minute_bar's session (ET date) is NEWER than the
--     latest daily_bar's date, the market is live and we're inside a
--     session whose close hasn't been written yet. price = minute_close,
--     prev_close = latest_daily_close.
--   - Otherwise the latest daily IS the current session's close
--     (post-close cron has run). price = latest_daily_close, prev_close
--     = prev_daily_close. This is also the steady-state for off-hours.

CREATE OR REPLACE FUNCTION get_watchlist_quotes(p_symbols text[])
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH latest_minute AS (
    SELECT DISTINCT ON (symbol)
      symbol, ts, close
    FROM minute_bars
    WHERE symbol = ANY(p_symbols)
      AND ts >= NOW() - INTERVAL '7 days'
    ORDER BY symbol, ts DESC
  ),
  latest_dailies AS (
    SELECT symbol, date, close, rn
    FROM (
      SELECT
        symbol, date, close,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
      FROM daily_bars
      WHERE symbol = ANY(p_symbols)
        AND date >= CURRENT_DATE - INTERVAL '14 days'
    ) t
    WHERE rn <= 2
  ),
  per_symbol AS (
    SELECT
      s.symbol,
      lm.close AS minute_close,
      lm.ts AS minute_ts,
      d1.close AS latest_daily_close,
      d1.date AS latest_daily_date,
      d2.close AS prev_daily_close,
      (lm.ts AT TIME ZONE 'America/New_York')::date AS minute_session_date
    FROM unnest(p_symbols) AS s(symbol)
    LEFT JOIN latest_minute lm ON lm.symbol = s.symbol
    LEFT JOIN latest_dailies d1 ON d1.symbol = s.symbol AND d1.rn = 1
    LEFT JOIN latest_dailies d2 ON d2.symbol = s.symbol AND d2.rn = 2
  )
  SELECT COALESCE(
    jsonb_object_agg(
      ps.symbol,
      jsonb_build_object(
        'price',
          CASE
            WHEN ps.minute_ts IS NOT NULL
              AND (ps.latest_daily_date IS NULL OR ps.minute_session_date > ps.latest_daily_date)
            THEN ps.minute_close
            ELSE ps.latest_daily_close
          END,
        'price_ts',
          CASE
            WHEN ps.minute_ts IS NOT NULL
              AND (ps.latest_daily_date IS NULL OR ps.minute_session_date > ps.latest_daily_date)
            THEN to_jsonb(ps.minute_ts)
            ELSE to_jsonb(ps.latest_daily_date)
          END,
        'prev_close',
          CASE
            WHEN ps.minute_ts IS NOT NULL
              AND (ps.latest_daily_date IS NULL OR ps.minute_session_date > ps.latest_daily_date)
            THEN ps.latest_daily_close
            ELSE ps.prev_daily_close
          END
      )
    ),
    '{}'::jsonb
  )
  FROM per_symbol ps;
$$;

GRANT EXECUTE ON FUNCTION get_watchlist_quotes(text[]) TO PUBLIC;
