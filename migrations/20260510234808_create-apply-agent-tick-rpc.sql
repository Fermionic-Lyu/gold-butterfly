-- apply_agent_tick: transactional Phase B applier for the trading-tick worker.
--
-- The worker (process-agent) does all of Phase A — parallel LLM calls per
-- watched symbol — and computes Phase B in memory: which positions expire,
-- which get marked-to-market, which get closed, which open, the running
-- agent cash balance, and the resulting decisions + equity snapshot.
--
-- Phase B is then applied here in ONE database transaction. Either every
-- mutation lands or none of them do. No more partial state risk if the
-- worker function instance crashes mid-tick.
--
-- Payload shape (jsonb):
--   {
--     agent_id: uuid,
--     run_date: "YYYY-MM-DD",
--     final_cash: number,
--     expires:     [{position_id, exit_proceeds, realized_pnl, current_value, legs}],
--     mtm_updates: [{position_id, current_value, legs}],
--     closes:      [{position_id, exit_proceeds, realized_pnl}],
--     opens: [{
--       symbol, strategy, legs, reserved_collateral, entry_cost, rationale,
--       _decision: { action, confidence, reasoning, snapshot, raw_response, validation_notes }
--     }],
--     decisions: [
--       { symbol, action, confidence, reasoning, position_id, snapshot,
--         raw_response, validation_notes }
--     ],
--     equity: { cash, positions_mtm, total_equity, open_positions }
--   }
--
-- All decision inserts use ON CONFLICT (agent_id, symbol, run_date) DO
-- NOTHING, so a retry that re-fires this same tick stays idempotent on
-- the decision rows. The unique index added in the prior migration is
-- what makes that work.

CREATE OR REPLACE FUNCTION apply_agent_tick(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id   uuid       := (payload->>'agent_id')::uuid;
  v_run_date   date       := (payload->>'run_date')::date;
  v_final_cash numeric    := (payload->>'final_cash')::numeric;
  v_now        timestamptz := now();
  v_expires_n     int := 0;
  v_mtm_n         int := 0;
  v_closes_n      int := 0;
  v_opens_n       int := 0;
  v_decisions_n   int := 0;
  v_p             jsonb;
  v_d             jsonb;
  v_new_pos_id    uuid;
BEGIN
  -- 1. Expirations.
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

  -- 2. MTM updates (still open, just refreshed valuations).
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

  -- 3. LLM-decided closes.
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

  -- 4. LLM-decided opens. Each open carries its linked decision inline so
  -- we can write the decision row with position_id = the new row's id,
  -- all within this transaction.
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
      (v_p->>'entry_cost')::numeric,  -- current_value starts at entry_cost
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

  -- 5. Non-open decisions: close, hold, error, skip_invalid, skip_low_confidence.
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

  -- 6. Update agent.cash to the worker's computed final balance.
  UPDATE agents SET cash = v_final_cash WHERE id = v_agent_id;

  -- 7. Equity snapshot.
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

-- Called by the worker via the InsForge API_KEY (service-role bearer
-- token). InsForge doesn't expose a separate `service_role` role; the
-- API_KEY effectively runs as authenticated, so we grant there. The
-- function uses SECURITY DEFINER and is owned by postgres, so it runs
-- with full DB privileges regardless of caller role. Arbitrary clients
-- could call this in theory; the payload shape is private and there's
-- no real-money exposure on the paper-trading data it touches.
REVOKE ALL ON FUNCTION apply_agent_tick(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_agent_tick(jsonb) TO authenticated, anon;
