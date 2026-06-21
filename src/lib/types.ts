export interface OptionContract {
  symbol: string;
  expiration: string;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  openInterest: number | null;
  volume: number | null;
  updated: string | null;
}

export interface RealizedVol {
  hv10: number | null;
  hv30: number | null;
  hv90: number | null;
  barCount: number;
}

export interface OptionChainResponse {
  symbol: string;
  underlying: { price: number | null; source: string; timestamp: string | null };
  expirations: string[];
  contracts: OptionContract[];
  contractCount: number;
  strikeBand?: { min: number | null; max: number | null; fraction: number };
  horizonDays?: number;
  realizedVol?: RealizedVol | null;
  fetchedAt: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  symbol: string;
  notes: string | null;
  created_at: string;
}

// Raw scraped article (one row per symbol+url). Written by the Modal
// scraper into the `company_news` table; read by NewsPanel.
export interface CompanyNews {
  id: string;
  symbol: string;
  source: string;
  headline: string;
  summary: string | null;
  url: string;
  image_url: string | null;
  category: string | null;
  published_at: string | null;
  scraped_at: string;
}

// Per-symbol, per-day LLM digest written by the analyze-news edge function
// into `news_analyses`.
export interface NewsAnalysis {
  id: string;
  symbol: string;
  as_of_date: string;
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number | null;
  summary: string;
  key_points: string[];
  options_impact: string | null;
  article_count: number;
  model: string | null;
  created_at: string;
}
