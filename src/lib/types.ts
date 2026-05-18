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
