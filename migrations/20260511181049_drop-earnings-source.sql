-- Single source of truth (Finnhub) — the provenance column was only useful
-- while we were juggling FMP + Finnhub. Drop it.

ALTER TABLE earnings_dates DROP COLUMN source;
