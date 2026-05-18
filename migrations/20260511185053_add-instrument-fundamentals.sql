-- Lightweight company fundamentals populated by fetch-fundamentals from
-- Finnhub's /stock/metric endpoint. Daily refresh.
--
-- market_cap: actual dollars (NUMERIC scales without precision concerns).
-- pe_ratio: trailing-twelve-month P/E (peTTM), falling back to
--           peNormalizedAnnual when TTM is unavailable. Both are stored
--           NULL when Finnhub doesn't surface them (e.g. foreign ADRs on
--           lower-tier subscriptions, recent IPOs).

ALTER TABLE instruments ADD COLUMN market_cap NUMERIC;
ALTER TABLE instruments ADD COLUMN pe_ratio NUMERIC;
