-- get_chain_view: single-call assembly of the dashboard's chain view.
--
-- Why: PostgREST is configured with max-rows=1000 server-side, which
-- silently truncates a plain SELECT against chain_quotes for any
-- underlying with more than 1000 rows (most NDX-100 names). Paging
-- works but costs 2-3 round trips per symbol switch and ships duplicate
-- column-name overhead for every row. An RPC returning a single JSONB
-- aggregate skips the row cap entirely and replaces those round trips
-- with one call.
--
-- Why not push aggregations (term structure, OI ratios, etc.) into this
-- function: the dashboard's chain-analysis logic is still actively
-- evolving in TypeScript. Moving it server-side would mean a migration
-- per metric tweak. So this function stays thin — it just returns the
-- underlying + the full contracts array, shaped to match the
-- OptionChainResponse type the React code already expects.

CREATE OR REPLACE FUNCTION get_chain_view(p_symbol text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'symbol', u.symbol,
    'underlying', jsonb_build_object(
      'price', u.spot,
      'source', u.spot_source,
      'timestamp', u.spot_ts
    ),
    'expirations', COALESCE(to_jsonb(u.expirations), '[]'::jsonb),
    'strikeBand', jsonb_build_object(
      'min', u.strike_min,
      'max', u.strike_max,
      'fraction', 0.35
    ),
    'horizonDays', 400,
    'realizedVol', NULL,
    'fetchedAt', u.fetched_at,
    'contracts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'symbol', q.occ_symbol,
          'expiration', to_char(q.expiration, 'YYYY-MM-DD'),
          'strike', q.strike,
          'type', q.type,
          'bid', q.bid,
          'ask', q.ask,
          'bidSize', q.bid_size,
          'askSize', q.ask_size,
          'last', q.last,
          'iv', q.iv,
          'delta', q.delta,
          'gamma', q.gamma,
          'theta', q.theta,
          'vega', q.vega,
          'rho', q.rho,
          'openInterest', q.open_interest,
          'volume', q.volume,
          'updated', q.updated
        )
        ORDER BY q.expiration ASC, q.strike ASC
      )
      FROM chain_quotes q
      WHERE q.underlying = u.symbol
    ), '[]'::jsonb),
    'contractCount', (
      SELECT COUNT(*) FROM chain_quotes q WHERE q.underlying = u.symbol
    )
  )
  FROM chain_underlyings u
  WHERE u.symbol = p_symbol
  LIMIT 1;
$$;

-- Allow the same roles that already call apply_agent_tick to call this.
GRANT EXECUTE ON FUNCTION get_chain_view(text) TO PUBLIC;
