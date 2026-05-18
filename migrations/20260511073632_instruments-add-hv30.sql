-- 30-day historical realized vol per symbol, computed and stored once per
-- trading day by the fetch-daily-bars edge function after writing the new
-- bars. Both the dashboard (regime card + IV/HV30 metric) and the
-- trading-tick worker (vol-regime gating in validateOpen) read it from
-- this single source so the displayed and decision-time values can't drift.
--
-- Computed as annualized stdev of log returns over the last 30 daily
-- closes × sqrt(252). NULL until fetch-daily-bars has populated it on
-- the next post-close run.
ALTER TABLE instruments ADD COLUMN hv30 NUMERIC;
