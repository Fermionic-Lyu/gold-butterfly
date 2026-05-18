-- Drop the MAG-7-only CHECK constraint on iv_snapshots.symbol so the
-- consolidated capture path inside fetch-chains can append rows for the
-- whole NDX-100 universe (and beyond). IV history table stays
-- append-only with the same (symbol, captured_at) PK; only the universe
-- restriction goes away.

ALTER TABLE iv_snapshots DROP CONSTRAINT iv_snapshots_symbol_check;
