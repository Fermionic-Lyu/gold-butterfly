-- Denormalize the EOD chain audit log to match the live chain_quotes /
-- chain_underlyings shape. The principle is consistent: never write
-- large JSONB payloads through PostgREST. Instead, the archive happens
-- entirely server-side via a SQL function (archive_chain_eod) that does
-- two INSERT INTO ... SELECT statements — no big payloads cross the
-- function/proxy boundary.
--
-- The old chain_history table (JSONB blob per symbol per day) is dropped.
-- The handful of rows there were from debugging and not worth preserving.

DROP TABLE IF EXISTS chain_history;

-- Per-contract historical rows. Same shape as chain_quotes plus a date
-- column. Indefinite retention is fine — ~97K rows/trading day × 252
-- days/year ≈ 25M rows/year × ~250 B = ~6 GB/year. If that ever becomes
-- a problem, partitioning or retention policy is easy to add later.
CREATE TABLE chain_quotes_history (
  date           DATE NOT NULL,
  underlying     TEXT NOT NULL,
  occ_symbol     TEXT NOT NULL,
  expiration     DATE NOT NULL,
  strike         NUMERIC NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('call', 'put')),
  bid            NUMERIC,
  ask            NUMERIC,
  bid_size       INTEGER,
  ask_size       INTEGER,
  last           NUMERIC,
  iv             NUMERIC,
  delta          NUMERIC,
  gamma          NUMERIC,
  theta          NUMERIC,
  vega           NUMERIC,
  rho            NUMERIC,
  open_interest  INTEGER,
  volume         BIGINT,
  updated        TIMESTAMPTZ,
  captured_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (date, underlying, occ_symbol)
);
CREATE INDEX idx_chain_quotes_history_date ON chain_quotes_history (date DESC);
CREATE INDEX idx_chain_quotes_history_und ON chain_quotes_history (underlying, date DESC);

ALTER TABLE chain_quotes_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chain_quotes_history_read_all"
  ON chain_quotes_history FOR SELECT
  TO authenticated, anon
  USING (true);

-- Per-symbol metadata snapshot per day. Mirror of chain_underlyings + date.
CREATE TABLE chain_underlyings_history (
  date           DATE NOT NULL,
  symbol         TEXT NOT NULL,
  spot           NUMERIC,
  spot_source    TEXT,
  spot_ts        TIMESTAMPTZ,
  expirations    TEXT[],
  contract_count INTEGER,
  strike_min     NUMERIC,
  strike_max     NUMERIC,
  fetched_at     TIMESTAMPTZ NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (date, symbol)
);
CREATE INDEX idx_chain_underlyings_history_date ON chain_underlyings_history (date DESC);

ALTER TABLE chain_underlyings_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chain_underlyings_history_read_all"
  ON chain_underlyings_history FOR SELECT
  TO authenticated, anon
  USING (true);

-- Server-side archival: copy chain_quotes + chain_underlyings into the
-- history tables stamped with `run_date`. The whole operation is one
-- transaction inside Postgres — zero chain data flows through PostgREST
-- (the edge function just calls this RPC with a date argument and gets
-- back a small row-count summary).
--
-- Idempotent: ON CONFLICT DO NOTHING on both inserts, so calling twice
-- for the same date is a no-op (lets the EOD scheduler retry safely).
CREATE OR REPLACE FUNCTION archive_chain_eod(run_date DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote_count        int := 0;
  v_underlying_count   int := 0;
  v_now                timestamptz := now();
BEGIN
  INSERT INTO chain_quotes_history (
    date, underlying, occ_symbol, expiration, strike, type,
    bid, ask, bid_size, ask_size, last, iv,
    delta, gamma, theta, vega, rho,
    open_interest, volume, updated, captured_at
  )
  SELECT
    run_date, underlying, occ_symbol, expiration, strike, type,
    bid, ask, bid_size, ask_size, last, iv,
    delta, gamma, theta, vega, rho,
    open_interest, volume, updated, fetched_at
  FROM chain_quotes
  ON CONFLICT (date, underlying, occ_symbol) DO NOTHING;
  GET DIAGNOSTICS v_quote_count = ROW_COUNT;

  INSERT INTO chain_underlyings_history (
    date, symbol, spot, spot_source, spot_ts,
    expirations, contract_count, strike_min, strike_max,
    fetched_at, captured_at
  )
  SELECT
    run_date, symbol, spot, spot_source, spot_ts,
    expirations, contract_count, strike_min, strike_max,
    fetched_at, v_now
  FROM chain_underlyings
  ON CONFLICT (date, symbol) DO NOTHING;
  GET DIAGNOSTICS v_underlying_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_date', run_date,
    'archived_at', v_now,
    'quotes_archived', v_quote_count,
    'underlyings_archived', v_underlying_count
  );
END;
$$;

-- Match the grant pattern of apply_agent_tick.
REVOKE ALL ON FUNCTION archive_chain_eod(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_chain_eod(DATE) TO authenticated, anon, project_admin;
