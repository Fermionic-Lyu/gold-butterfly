"""Trading-agent worker, ported from functions/trading-tick.ts to run on Modal.

The transactional core stays in Postgres (the apply_agent_tick RPC + lease);
this package is the *compute* — Phase A (fan-out: price positions, analyze each
watched symbol, ask the agent's LLM for a decision) and Phase B (rank/validate/
assemble the payload) — which Modal runs with real parallelism across agents.
"""
