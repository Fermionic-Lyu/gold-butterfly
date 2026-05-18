-- Switching from FMP /stable/earnings-calendar to Finnhub /calendar/earnings.
-- Finnhub returns BMO/AMC in a `hour` field (populated for most large caps),
-- so re-add the `time` column we dropped a few minutes ago. Skip the
-- fiscal-period columns — Finnhub populates them but `date` alone is enough
-- to order events on the chart.
--
-- Wipe rows from the FMP run so we don't end up with a mixed-source table
-- where a few NVDA/WMT/COST rows linger with `source='fmp'`. Cheap to refill
-- on the next scheduled tick (or the manual invoke immediately after).

TRUNCATE TABLE earnings_dates;

ALTER TABLE earnings_dates ADD COLUMN time TEXT CHECK (time IN ('bmo', 'amc', 'dmh'));
