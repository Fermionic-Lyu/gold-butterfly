-- Add the `skip_outranked` decision action.
--
-- When an agent's parallel-analyze phase produces more `open` proposals
-- than its max_concurrent_positions cap (or cash / per-symbol
-- concentration headroom) allows, the trading-tick function ranks them
-- by self-reported confidence and commits only the top K. The surplus
-- proposals are recorded with action='skip_outranked' so the audit
-- log shows which signals lost the race rather than silently dropping
-- them. The validation_notes column carries the specific resource that
-- was exhausted ("at max concurrent positions", "insufficient cash
-- after prior commits", etc.).

ALTER TABLE decisions
  DROP CONSTRAINT decisions_action_check;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_action_check
  CHECK (action = ANY (ARRAY[
    'open',
    'close',
    'hold',
    'skip_low_confidence',
    'skip_invalid',
    'skip_outranked',
    'error'
  ]));
