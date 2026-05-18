-- Paper-trading agents framework. One row in `agents` defines an autonomous
-- trader; positions / decisions / equity_snapshots are its append-only ledger.
-- The trading-tick edge function reads the agent's preset, builds a prompt
-- containing portfolio state + market snapshot, and applies the LLM's decision
-- (open | close | hold). Multiple agents with different models / strategy
-- focuses can be compared head-to-head by APY.

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  focus TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  preset JSONB NOT NULL,
  watched_symbols TEXT[] NOT NULL DEFAULT '{}',
  starting_capital NUMERIC NOT NULL DEFAULT 100000,
  cash NUMERIC NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  legs JSONB NOT NULL,
  reserved_collateral NUMERIC NOT NULL DEFAULT 0,
  entry_cost NUMERIC NOT NULL,
  current_value NUMERIC,
  exit_proceeds NUMERIC,
  realized_pnl NUMERIC,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','expired')),
  rationale TEXT,
  decision_id UUID,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  mtm_at TIMESTAMPTZ
);

CREATE INDEX idx_positions_agent_status ON positions (agent_id, status);
CREATE INDEX idx_positions_agent_symbol_status ON positions (agent_id, symbol, status);

CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL CHECK (action IN ('open','close','hold','skip_low_confidence','skip_invalid','error')),
  confidence NUMERIC,
  reasoning TEXT,
  position_id UUID,
  snapshot JSONB,
  raw_response JSONB,
  validation_notes TEXT
);

CREATE INDEX idx_decisions_agent_time ON decisions (agent_id, decided_at DESC);
CREATE INDEX idx_decisions_agent_symbol_time ON decisions (agent_id, symbol, decided_at DESC);

CREATE TABLE equity_snapshots (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cash NUMERIC NOT NULL,
  positions_mtm NUMERIC NOT NULL,
  total_equity NUMERIC NOT NULL,
  open_positions INTEGER NOT NULL,
  PRIMARY KEY (agent_id, recorded_at)
);

-- Public-read for transparency; writes only via service role.
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agents_read_all" ON agents FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "positions_read_all" ON positions FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "decisions_read_all" ON decisions FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "equity_snapshots_read_all" ON equity_snapshots FOR SELECT TO authenticated, anon USING (true);

-- Seed: Theta the Premium Collector.
INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash) VALUES (
  'theta-premium-collector',
  'Theta the Premium Collector',
  'premium_seller',
  'anthropic/claude-sonnet-4.5',
  $$You are Theta the Premium Collector — a disciplined, mechanical options-premium seller in the TastyTrade tradition. Your edge is selling rich implied volatility and letting time decay work in your favor.

NON-NEGOTIABLE METHODOLOGY:
1. VOL REGIME FIRST. Only sell premium when vol is rich: IV/HV ≥ 1.10 OR IV Rank ≥ 30. If neither holds, you MUST output "hold" or "skip_low_confidence" — do not force trades.
2. EXPIRATIONS: 25–50 DTE only. Never trade weeklies, never trade past 60 DTE.
3. SHORT LEGS: target 16–25 delta. Defined-risk preferred over naked.
4. POSITION SIZING: each new trade ≤ 20% of starting capital in defined-loss; ≤ 30% concentration per symbol.
5. PROFIT TAKING: close at ~50% of credit captured. Manage at 21 DTE (close losers, take winners).
6. CONFIDENCE: only enter trades with ≥ 0.62 self-rated confidence. Never trade for the sake of trading.

ALLOWED STRATEGIES:
- cash_secured_put — sell 1 put, 16–25Δ; collateral = strike × 100
- covered_call — long 100 shares + sell 1 call at 25–30Δ (only if you already hold ≥ 100 shares of the underlying)
- bull_put_credit_spread — sell put higher strike (16–25Δ), buy put lower strike for protection; collateral = width × 100
- bear_call_credit_spread — sell call lower strike (16–25Δ), buy call higher strike; collateral = width × 100
- iron_condor — combine bull_put + bear_call with balanced wings; collateral = max wing width × 100

DECISION ACTIONS PER TICK (one symbol at a time):
- "open" — propose a NEW position with full leg detail; reference only OCC symbols / strikes / expirations from the snapshot.
- "close" — close one of YOUR currently-open positions on this symbol (specify position_id).
- "hold" — no action this tick.

Output a single JSON object with: action, confidence (0..1), reasoning (≤ 50 words), and either an "open" or "close" sub-object as appropriate. No prose outside JSON, no code fences.$$,
  '{
    "max_concurrent_positions": 5,
    "max_position_size_pct": 0.20,
    "max_concentration_per_symbol_pct": 0.30,
    "min_confidence_to_trade": 0.62,
    "min_dte": 25,
    "max_dte": 50,
    "allowed_strategies": ["cash_secured_put","covered_call","bull_put_credit_spread","bear_call_credit_spread","iron_condor"],
    "vol_view_required": "rich_or_fair",
    "profit_target_pct": 0.5,
    "manage_at_dte": 21
  }'::jsonb,
  ARRAY['AAPL','MSFT','NVDA','AMZN'],
  100000,
  100000
);
