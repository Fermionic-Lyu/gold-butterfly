-- Normalize chain_snapshots from one giant JSONB row per symbol to per-
-- contract rows plus a small per-symbol metadata row. Engineer diagnosis
-- of the PostgREST OOM-restart cascade pointed at the ~77 KB JSONB rows
-- as the proximate cause — every cron tick was burst-writing ~14 MB of
-- TOAST'd payloads through the proxy's request memory, repeatedly
-- pushing it over its container memory ceiling.
--
-- New shape:
--   chain_quotes        — one row per option contract (~120 B, inline heap, no TOAST).
--                         ~100K rows steady state (100 symbols × ~1000 contracts).
--                         Updated on each fetch-chains tick via UPSERT
--                         (merge-duplicates on the (underlying, occ_symbol) PK).
--                         Stale contracts that fall out of the universe are
--                         deleted by fetch-chains at the end of each tick.
--   chain_underlyings   — one row per symbol with the spot price, source, list of
--                         expirations, contract count, and fetch timestamp.
--                         ~100 rows, no TOAST.
--
-- chain_history (the EOD append-only audit table) keeps its JSONB shape —
-- append-only TOAST is fine because it doesn't churn. snapshot-chain-eod
-- will reconstruct the JSONB from the new tables at EOD.

CREATE TABLE chain_quotes (
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
  fetched_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (underlying, occ_symbol)
);

-- Most common access pattern: "give me all contracts for AAPL at expiration 2026-06-19"
CREATE INDEX idx_chain_quotes_und_exp ON chain_quotes (underlying, expiration, strike);
-- "freshness sweep" for any future cleanup
CREATE INDEX idx_chain_quotes_fetched ON chain_quotes (fetched_at);

ALTER TABLE chain_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chain_quotes_read_all"
  ON chain_quotes FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE TABLE chain_underlyings (
  symbol         TEXT PRIMARY KEY,
  spot           NUMERIC,
  spot_source    TEXT,
  spot_ts        TIMESTAMPTZ,
  expirations    TEXT[] NOT NULL DEFAULT '{}',
  contract_count INTEGER NOT NULL DEFAULT 0,
  strike_min     NUMERIC,
  strike_max     NUMERIC,
  fetched_at     TIMESTAMPTZ NOT NULL
);

ALTER TABLE chain_underlyings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chain_underlyings_read_all"
  ON chain_underlyings FOR SELECT
  TO authenticated, anon
  USING (true);
