-- Daily financial news for the symbols users subscribe to, plus a per-symbol
-- per-day LLM digest of that news.
--
-- Pipeline (two stages, two platforms):
--   1. SCRAPE  — a Modal cron job (modal/scrape_news.py) pulls news for the
--      distinct union of subscribed symbols from several free sources
--      (Finnhub /company-news, Yahoo Finance RSS, Google News RSS), extracts
--      the article body, and UPSERTs raw items into `company_news`.
--   2. ANALYZE — the `analyze-news` edge function reads the day's freshly
--      scraped items per symbol, asks an LLM (via OpenRouter) for a sentiment
--      read + digest + options-relevant impact, and UPSERTs one row per
--      (symbol, day) into `news_analyses`.
--
-- Both tables are public reference data: any signed-in user (and anon, for
-- the demo) can read; writes happen only through the privileged scrape/
-- analyze jobs, which use the service key and bypass RLS — so there are no
-- INSERT/UPDATE policies, exactly like `instruments` and `earnings_dates`.

-- ── Raw scraped articles ──────────────────────────────────────────────────
CREATE TABLE company_news (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  -- Origin of the item: 'finnhub' | 'yahoo' | 'google_news' (or a source
  -- hostname). Lets the UI badge provenance and lets us tune per-source trust.
  source TEXT NOT NULL,
  headline TEXT NOT NULL,
  -- Provider-supplied snippet (Finnhub summary / RSS description).
  summary TEXT,
  -- Main article body extracted by trafilatura during scraping. NULL when
  -- extraction failed (paywall, JS-only render we didn't fall back on, etc.) —
  -- the analyzer then leans on headline + summary alone.
  full_text TEXT,
  url TEXT NOT NULL,
  image_url TEXT,
  category TEXT,
  -- When the article was published (provider timestamp). NULL if unparseable.
  published_at TIMESTAMPTZ,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per article per symbol. The same wire story can legitimately be
  -- tagged to multiple tickers, so url alone is not unique — (symbol, url) is.
  UNIQUE (symbol, url)
);

CREATE INDEX idx_company_news_symbol_published ON company_news (symbol, published_at DESC);
CREATE INDEX idx_company_news_scraped ON company_news (scraped_at DESC);

ALTER TABLE company_news ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_news_read_all"
  ON company_news FOR SELECT
  TO authenticated, anon
  USING (true);

-- ── Per-symbol, per-day LLM digest ────────────────────────────────────────
CREATE TABLE news_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
  -- The trading/calendar day the digest summarizes (UTC date of the scrape).
  as_of_date DATE NOT NULL,
  -- Coarse label for badges/filtering.
  sentiment TEXT NOT NULL CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'mixed')),
  -- Continuous read in [-1, 1] for sorting/sparklines; -1 most bearish.
  sentiment_score NUMERIC,
  summary TEXT NOT NULL,
  -- Array of short bullet strings (catalysts, themes, risks).
  key_points JSONB NOT NULL DEFAULT '[]',
  -- How the day's news might bear on implied vol / options positioning —
  -- the angle that makes this useful inside an options sandbox.
  options_impact TEXT,
  -- How many scraped articles fed this digest.
  article_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotent re-runs: one digest per symbol per day. The analyzer upserts
  -- with ?on_conflict=symbol,as_of_date so a retry overwrites cleanly.
  UNIQUE (symbol, as_of_date)
);

CREATE INDEX idx_news_analyses_symbol_date ON news_analyses (symbol, as_of_date DESC);

ALTER TABLE news_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "news_analyses_read_all"
  ON news_analyses FOR SELECT
  TO authenticated, anon
  USING (true);
