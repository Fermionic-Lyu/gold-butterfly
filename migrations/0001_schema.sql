-- Baseline schema. The API server is the only database client and enforces
-- per-user access in code, so no row-level security is declared here.

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);

CREATE TABLE instruments (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  indices TEXT[] NOT NULL DEFAULT '{}',
  logo_url TEXT,
  hv30 NUMERIC,
  market_cap NUMERIC,
  pe_ratio NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_instruments_name_lower ON instruments (LOWER(name));
CREATE INDEX idx_instruments_indices ON instruments USING GIN (indices);

CREATE TABLE iv_snapshots (
  symbol TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  spot NUMERIC,
  atm_iv NUMERIC,
  atm_call_iv NUMERIC,
  atm_put_iv NUMERIC,
  primary_expiration DATE,
  primary_dte INTEGER,
  hv30 NUMERIC,
  PRIMARY KEY (symbol, captured_at)
);
CREATE INDEX idx_iv_snapshots_symbol_time ON iv_snapshots (symbol, captured_at DESC);

CREATE TABLE strategy_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  analysis JSONB NOT NULL,
  model TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_strategy_analyses_user_symbol_time
  ON strategy_analyses (user_id, symbol, generated_at DESC);

-- Paper-trading agents. user_id NULL marks the shipped defaults.
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
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_user_id ON agents (user_id);

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
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  mtm_at TIMESTAMPTZ
);
CREATE INDEX idx_positions_agent_status ON positions (agent_id, status);
CREATE INDEX idx_positions_agent_symbol_status ON positions (agent_id, symbol, status);

CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_date DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'open','close','hold','skip_low_confidence','skip_invalid','skip_outranked','error'
  )),
  confidence NUMERIC,
  reasoning TEXT,
  position_id UUID,
  snapshot JSONB,
  raw_response JSONB,
  validation_notes TEXT
);
CREATE INDEX idx_decisions_agent_time ON decisions (agent_id, decided_at DESC);
CREATE INDEX idx_decisions_agent_symbol_time ON decisions (agent_id, symbol, decided_at DESC);
-- One decision per (agent, symbol, trading day) makes tick retries idempotent.
CREATE UNIQUE INDEX decisions_unique_per_day ON decisions (agent_id, symbol, run_date);

CREATE TABLE equity_snapshots (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cash NUMERIC NOT NULL,
  positions_mtm NUMERIC NOT NULL,
  total_equity NUMERIC NOT NULL,
  open_positions INTEGER NOT NULL,
  PRIMARY KEY (agent_id, recorded_at)
);

CREATE TABLE agent_runs (
  run_date DATE NOT NULL,
  agent_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (run_date, agent_slug)
);
CREATE INDEX idx_agent_runs_date_desc ON agent_runs (run_date DESC, agent_slug);

-- Lease acquired inside apply_agent_tick: exactly one apply per (agent, day).
CREATE TABLE agent_tick_applied (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, run_date)
);

CREATE TABLE minute_bars (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC NOT NULL,
  volume BIGINT,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX idx_minute_bars_symbol_ts_desc ON minute_bars (symbol, ts DESC);

CREATE TABLE daily_bars (
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC NOT NULL,
  volume BIGINT,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_daily_bars_symbol_date_desc ON daily_bars (symbol, date DESC);

-- One row per exception to "US equities trade Mon-Fri": NULL early_close_et is
-- a full closure, a time is a half-day.
CREATE TABLE market_holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL,
  early_close_et TIME
);

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
CREATE INDEX idx_chain_quotes_und_exp ON chain_quotes (underlying, expiration, strike);
CREATE INDEX idx_chain_quotes_fetched ON chain_quotes (fetched_at);

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

CREATE TABLE earnings_dates (
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  date DATE NOT NULL,
  eps_estimate NUMERIC,
  eps_actual NUMERIC,
  revenue_estimate NUMERIC,
  revenue_actual NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_earnings_dates_date ON earnings_dates (date);
CREATE INDEX idx_earnings_dates_symbol_date ON earnings_dates (symbol, date DESC);

CREATE TABLE company_news (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  source TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  full_text TEXT,
  url TEXT NOT NULL,
  image_url TEXT,
  category TEXT,
  published_at TIMESTAMPTZ,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, url)
);
CREATE INDEX idx_company_news_symbol_published ON company_news (symbol, published_at DESC);
CREATE INDEX idx_company_news_scraped ON company_news (scraped_at DESC);

CREATE TABLE news_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'mixed')),
  sentiment_score NUMERIC,
  summary TEXT NOT NULL,
  key_points JSONB NOT NULL DEFAULT '[]',
  options_impact TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, as_of_date)
);
CREATE INDEX idx_news_analyses_symbol_date ON news_analyses (symbol, as_of_date DESC);

-- Every scheduled/manual job execution, for the ops view.
CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','error','skipped')),
  args JSONB,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_job_runs_job_started ON job_runs (job, started_at DESC);
