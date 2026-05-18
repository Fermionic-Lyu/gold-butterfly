-- FMP's /stable/earnings-calendar endpoint dropped BMO/AMC + fiscal-period
-- fields when they retired the legacy v3 API on 2025-08-31. The columns are
-- always NULL now, so remove them rather than carry dead schema. If a
-- richer source surfaces these later, re-add as a follow-up migration.

ALTER TABLE earnings_dates DROP COLUMN time;
ALTER TABLE earnings_dates DROP COLUMN fiscal_period;
ALTER TABLE earnings_dates DROP COLUMN fiscal_year;
