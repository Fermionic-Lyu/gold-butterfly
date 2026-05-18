-- get_agents_summary: live MTM snapshot for every active agent.
--
-- The trading-tick worker only fires once per US trading day, so
-- positions.current_value, agents.cash, and equity_snapshots all stay
-- frozen until the post-close run. The dashboard's "Trading Lab" drawer
-- and per-agent page show stale values during the trading day. This
-- function computes intraday MTM on demand by joining each open
-- position's legs against chain_quotes (for option mids) and
-- chain_underlyings (for stock spots), then aggregating up to per-agent
-- totals.
--
-- The math mirrors markToMarketPosition in trading-tick/index.ts:
--   leg_value      = sign * qty * price * (stock ? 1 : 100)
--   current_value  = sum(leg_value) + reserved_collateral
--   positions_mtm  = sum(current_value across agent's open positions)
--   total_equity   = cash + positions_mtm
-- so the dashboard and worker stay consistent.
--
-- prev_session_equity is the most recent equity_snapshot before the
-- start of today's ET trading session, used to compute today's intraday
-- change. Falls back to starting_capital client-side if null (first day).
--
-- Note: this does NOT compute intrinsic value for legs whose expiration
-- has already passed (chain_quotes won't have those rows, so the price
-- falls back to the stored current_price or fill_price). That's fine in
-- practice because trading-tick expires those positions on the day's
-- post-close run; the brief window during the expiration-day trading
-- session would show a slightly stale leg price.

CREATE OR REPLACE FUNCTION get_agents_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  -- ET-midnight today, expressed as a UTC timestamp so we can compare
  -- it directly against equity_snapshots.recorded_at (timestamptz).
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
        -- Stock leg → underlying spot from chain_underlyings.
        CASE WHEN l.instrument = 'stock' THEN cu.spot ELSE NULL END,
        -- Option leg → mid of bid/ask from chain_quotes for the leg's OCC.
        CASE
          WHEN l.instrument IN ('call','put')
            AND cq.bid IS NOT NULL AND cq.ask IS NOT NULL
            AND cq.bid >= 0 AND cq.ask > 0
          THEN (cq.bid + cq.ask) / 2.0
          ELSE NULL
        END,
        -- Fallbacks for legs whose live quote we can't find (expired
        -- options, missing data) — preserves whatever trading-tick last
        -- wrote, or worst-case the fill price.
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
      -- Per-leg blob with current_price filled in for client-side display.
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

GRANT EXECUTE ON FUNCTION get_agents_summary() TO PUBLIC;
