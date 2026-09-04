-- apply_agent_tick: transactional Phase B applier for the trading tick.
--
-- Payload shape (jsonb):
--   {
--     agent_id: uuid, run_date: "YYYY-MM-DD", final_cash: number,
--     expires:     [{position_id, exit_proceeds, realized_pnl, current_value, legs}],
--     mtm_updates: [{position_id, current_value, legs}],
--     closes:      [{position_id, exit_proceeds, realized_pnl}],
--     opens: [{ symbol, strategy, legs, reserved_collateral, entry_cost, rationale,
--               _decision: { action, confidence, reasoning, snapshot, raw_response, validation_notes } }],
--     decisions: [{ symbol, action, confidence, reasoning, position_id, snapshot, raw_response, validation_notes }],
--     equity: { cash, positions_mtm, total_equity, open_positions }
--   }
CREATE OR REPLACE FUNCTION apply_agent_tick(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_agent_id   uuid       := (payload->>'agent_id')::uuid;
  v_run_date   date       := (payload->>'run_date')::date;
  v_final_cash numeric    := (payload->>'final_cash')::numeric;
  v_now        timestamptz := now();
  v_lease_acquired int := 0;
  v_expires_n     int := 0;
  v_mtm_n         int := 0;
  v_closes_n      int := 0;
  v_opens_n       int := 0;
  v_decisions_n   int := 0;
  v_p             jsonb;
  v_d             jsonb;
  v_new_pos_id    uuid;
BEGIN
  -- Lease: exactly one caller commits for (agent, day); a rollback releases it.
  INSERT INTO agent_tick_applied (agent_id, run_date, applied_at)
  VALUES (v_agent_id, v_run_date, v_now)
  ON CONFLICT (agent_id, run_date) DO NOTHING;
  GET DIAGNOSTICS v_lease_acquired = ROW_COUNT;

  IF v_lease_acquired = 0 THEN
    RETURN jsonb_build_object(
      'skipped', true,
      'reason', 'agent_tick_already_applied',
      'agent_id', v_agent_id,
      'run_date', v_run_date
    );
  END IF;

  FOR v_p IN
    SELECT * FROM jsonb_array_elements(coalesce(payload->'expires', '[]'::jsonb))
  LOOP
    UPDATE positions SET
      status        = 'expired',
      closed_at     = v_now,
      exit_proceeds = (v_p->>'exit_proceeds')::numeric,
      realized_pnl  = (v_p->>'realized_pnl')::numeric,
      current_value = (v_p->>'current_value')::numeric,
      legs          = v_p->'legs',
      mtm_at        = v_now
    WHERE id = (v_p->>'position_id')::uuid
      AND agent_id = v_agent_id;
    v_expires_n := v_expires_n + 1;
  END LOOP;

  FOR v_p IN
    SELECT * FROM jsonb_array_elements(coalesce(payload->'mtm_updates', '[]'::jsonb))
  LOOP
    UPDATE positions SET
      current_value = (v_p->>'current_value')::numeric,
      legs          = v_p->'legs',
      mtm_at        = v_now
    WHERE id = (v_p->>'position_id')::uuid
      AND agent_id = v_agent_id;
    v_mtm_n := v_mtm_n + 1;
  END LOOP;

  FOR v_p IN
    SELECT * FROM jsonb_array_elements(coalesce(payload->'closes', '[]'::jsonb))
  LOOP
    UPDATE positions SET
      status        = 'closed',
      closed_at     = v_now,
      exit_proceeds = (v_p->>'exit_proceeds')::numeric,
      realized_pnl  = (v_p->>'realized_pnl')::numeric
    WHERE id = (v_p->>'position_id')::uuid
      AND agent_id = v_agent_id;
    v_closes_n := v_closes_n + 1;
  END LOOP;

  FOR v_p IN
    SELECT * FROM jsonb_array_elements(coalesce(payload->'opens', '[]'::jsonb))
  LOOP
    INSERT INTO positions (
      agent_id, symbol, strategy, legs,
      reserved_collateral, entry_cost, current_value,
      status, rationale, mtm_at
    ) VALUES (
      v_agent_id,
      v_p->>'symbol',
      v_p->>'strategy',
      v_p->'legs',
      (v_p->>'reserved_collateral')::numeric,
      (v_p->>'entry_cost')::numeric,
      (v_p->>'entry_cost')::numeric,
      'open',
      v_p->>'rationale',
      v_now
    )
    RETURNING id INTO v_new_pos_id;
    v_opens_n := v_opens_n + 1;

    v_d := v_p->'_decision';
    IF v_d IS NOT NULL THEN
      INSERT INTO decisions (
        agent_id, symbol, action, confidence, reasoning,
        position_id, snapshot, raw_response, validation_notes, run_date
      ) VALUES (
        v_agent_id,
        v_p->>'symbol',
        v_d->>'action',
        NULLIF(v_d->>'confidence', '')::numeric,
        v_d->>'reasoning',
        v_new_pos_id,
        v_d->'snapshot',
        v_d->'raw_response',
        v_d->>'validation_notes',
        v_run_date
      )
      ON CONFLICT (agent_id, symbol, run_date) DO NOTHING;
      v_decisions_n := v_decisions_n + 1;
    END IF;
  END LOOP;

  FOR v_d IN
    SELECT * FROM jsonb_array_elements(coalesce(payload->'decisions', '[]'::jsonb))
  LOOP
    INSERT INTO decisions (
      agent_id, symbol, action, confidence, reasoning,
      position_id, snapshot, raw_response, validation_notes, run_date
    ) VALUES (
      v_agent_id,
      v_d->>'symbol',
      v_d->>'action',
      NULLIF(v_d->>'confidence', '')::numeric,
      v_d->>'reasoning',
      NULLIF(v_d->>'position_id', '')::uuid,
      v_d->'snapshot',
      v_d->'raw_response',
      v_d->>'validation_notes',
      v_run_date
    )
    ON CONFLICT (agent_id, symbol, run_date) DO NOTHING;
    v_decisions_n := v_decisions_n + 1;
  END LOOP;

  UPDATE agents SET cash = v_final_cash WHERE id = v_agent_id;

  IF payload ? 'equity' AND payload->'equity' IS NOT NULL THEN
    INSERT INTO equity_snapshots (
      agent_id, recorded_at, cash, positions_mtm, total_equity, open_positions
    ) VALUES (
      v_agent_id,
      v_now,
      (payload->'equity'->>'cash')::numeric,
      (payload->'equity'->>'positions_mtm')::numeric,
      (payload->'equity'->>'total_equity')::numeric,
      (payload->'equity'->>'open_positions')::int
    );
  END IF;

  RETURN jsonb_build_object(
    'applied_at',  v_now,
    'expires',     v_expires_n,
    'mtm_updates', v_mtm_n,
    'closes',      v_closes_n,
    'opens',       v_opens_n,
    'decisions',   v_decisions_n
  );
END;
$$;

-- archive_chain_eod: copy the live chain into the history tables for one day.
-- Idempotent — ON CONFLICT DO NOTHING lets the EOD job retry safely.
CREATE OR REPLACE FUNCTION archive_chain_eod(run_date DATE)
RETURNS jsonb
LANGUAGE plpgsql
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

-- get_chain_view: the dashboard's chain payload, shaped as OptionChainResponse.
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

-- recompute_hv30_for_ndx: annualized stdev of log returns over the trailing
-- 31 closes, written to instruments.hv30 for every NDX symbol with >= 10 returns.
CREATE OR REPLACE FUNCTION recompute_hv30_for_ndx()
RETURNS TABLE(symbol text, hv30 numeric)
LANGUAGE sql
AS $$
  WITH ranked AS (
    SELECT
      db.symbol,
      db.date,
      db.close,
      LAG(db.close) OVER (PARTITION BY db.symbol ORDER BY db.date) AS prev_close,
      ROW_NUMBER() OVER (PARTITION BY db.symbol ORDER BY db.date DESC) AS rn
    FROM daily_bars db
    JOIN instruments i
      ON i.symbol = db.symbol AND i.indices @> ARRAY['NDX']
  ),
  log_returns AS (
    SELECT r.symbol, LN(r.close / r.prev_close) AS lr
    FROM ranked r
    WHERE r.rn <= 31 AND r.prev_close IS NOT NULL AND r.prev_close > 0
  ),
  computed AS (
    SELECT
      lr.symbol,
      (STDDEV_SAMP(lr.lr) * SQRT(252))::numeric AS hv
    FROM log_returns lr
    GROUP BY lr.symbol
    HAVING COUNT(*) >= 10
  )
  UPDATE instruments i
  SET hv30 = c.hv
  FROM computed c
  WHERE i.symbol = c.symbol
  RETURNING i.symbol::text, i.hv30;
$$;

-- get_watchlist_quotes: price + prev_close per symbol using trading-session
-- semantics (a newer minute bar than the latest daily bar means the session
-- is live and its close has not been written yet).
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

-- get_agents_summary: live mark-to-market for every active agent, pricing open
-- legs off chain_quotes / chain_underlyings with the same math as the tick.
CREATE OR REPLACE FUNCTION get_agents_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  et_today_start AS (
    SELECT (date_trunc('day', now() AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'America/New_York') AS ts
  ),
  open_pos AS (
    SELECT p.*
    FROM positions p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.status = 'open' AND a.active
  ),
  legs AS (
    SELECT
      p.id AS position_id,
      p.agent_id,
      (leg ->> 'sign')::int AS sign,
      (leg ->> 'qty')::numeric AS qty,
      leg ->> 'instrument' AS instrument,
      leg ->> 'symbol' AS leg_symbol,
      (leg ->> 'fill_price')::numeric AS fill_price,
      CASE
        WHEN leg ? 'current_price' AND (leg ->> 'current_price') IS NOT NULL
        THEN (leg ->> 'current_price')::numeric
        ELSE NULL
      END AS stored_current_price,
      leg AS raw_leg
    FROM open_pos p,
    LATERAL jsonb_array_elements(p.legs) AS leg
  ),
  legs_priced AS (
    SELECT
      l.*,
      COALESCE(
        CASE WHEN l.instrument = 'stock' THEN cu.spot ELSE NULL END,
        CASE
          WHEN l.instrument IN ('call','put')
            AND cq.bid IS NOT NULL AND cq.ask IS NOT NULL
            AND cq.bid >= 0 AND cq.ask > 0
          THEN (cq.bid + cq.ask) / 2.0
          ELSE NULL
        END,
        l.stored_current_price,
        l.fill_price
      )::numeric AS live_price,
      CASE WHEN l.instrument = 'stock' THEN 1 ELSE 100 END AS multiplier
    FROM legs l
    LEFT JOIN chain_underlyings cu
      ON l.instrument = 'stock' AND cu.symbol = l.leg_symbol
    LEFT JOIN chain_quotes cq
      ON l.instrument IN ('call','put') AND cq.occ_symbol = l.leg_symbol
  ),
  position_mtm AS (
    SELECT
      lp.position_id,
      lp.agent_id,
      jsonb_agg(
        jsonb_set(lp.raw_leg, '{current_price}', to_jsonb(lp.live_price))
      ) AS legs_with_live,
      SUM(lp.sign * lp.qty * lp.live_price * lp.multiplier) AS legs_value
    FROM legs_priced lp
    GROUP BY lp.position_id, lp.agent_id
  ),
  position_full AS (
    SELECT
      p.id,
      p.agent_id,
      p.symbol,
      p.strategy,
      pm.legs_with_live AS legs,
      p.reserved_collateral,
      p.entry_cost,
      (pm.legs_value + p.reserved_collateral)::numeric AS live_current_value,
      p.status,
      p.rationale,
      p.opened_at,
      p.closed_at,
      p.mtm_at,
      p.realized_pnl,
      p.exit_proceeds
    FROM open_pos p
    JOIN position_mtm pm ON pm.position_id = p.id
  ),
  agent_position_agg AS (
    SELECT
      pf.agent_id,
      jsonb_agg(
        jsonb_build_object(
          'id', pf.id,
          'agent_id', pf.agent_id,
          'symbol', pf.symbol,
          'strategy', pf.strategy,
          'legs', pf.legs,
          'reserved_collateral', pf.reserved_collateral,
          'entry_cost', pf.entry_cost,
          'current_value', pf.live_current_value,
          'exit_proceeds', pf.exit_proceeds,
          'realized_pnl', pf.realized_pnl,
          'status', pf.status,
          'rationale', pf.rationale,
          'opened_at', pf.opened_at,
          'closed_at', pf.closed_at,
          'mtm_at', pf.mtm_at
        )
        ORDER BY pf.opened_at DESC
      ) AS positions,
      SUM(pf.live_current_value) AS positions_mtm,
      COUNT(*)::int AS open_positions
    FROM position_full pf
    GROUP BY pf.agent_id
  ),
  agent_state AS (
    SELECT
      a.id AS agent_id,
      a.slug AS agent_slug,
      a.cash,
      a.starting_capital,
      COALESCE(apa.positions_mtm, 0) AS positions_mtm,
      (a.cash + COALESCE(apa.positions_mtm, 0))::numeric AS total_equity,
      COALESCE(apa.open_positions, 0) AS open_positions,
      COALESCE(apa.positions, '[]'::jsonb) AS positions,
      (
        SELECT es.total_equity
        FROM equity_snapshots es, et_today_start ts
        WHERE es.agent_id = a.id
          AND es.recorded_at < ts.ts
        ORDER BY es.recorded_at DESC
        LIMIT 1
      ) AS prev_session_equity
    FROM agents a
    LEFT JOIN agent_position_agg apa ON apa.agent_id = a.id
    WHERE a.active
  )
  SELECT COALESCE(
    jsonb_object_agg(
      s.agent_slug,
      jsonb_build_object(
        'agent_id', s.agent_id,
        'cash', s.cash,
        'starting_capital', s.starting_capital,
        'positions_mtm', s.positions_mtm,
        'total_equity', s.total_equity,
        'open_positions', s.open_positions,
        'prev_session_equity', s.prev_session_equity,
        'positions', s.positions
      )
    ),
    '{}'::jsonb
  )
  FROM agent_state s;
$$;
