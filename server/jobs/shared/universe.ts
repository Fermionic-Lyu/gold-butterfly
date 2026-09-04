import { query } from "../../db.ts";

// The instruments table is the tracked universe: every row gets bars, chains,
// news and (with Finnhub) fundamentals. Seeded from data/instruments/*.json.
export async function trackedSymbols(): Promise<string[]> {
  const rows = await query<{ symbol: string }>("SELECT symbol FROM instruments ORDER BY symbol");
  return rows.map((r) => r.symbol);
}

export async function allInstruments(): Promise<{ symbol: string; name: string }[]> {
  return query("SELECT symbol, name FROM instruments ORDER BY symbol");
}

// Optional `args.symbols` narrows a job to a subset of the universe.
export function pickSymbols(all: string[], requested: unknown): { symbols: string[]; subset: boolean } {
  if (!Array.isArray(requested) || requested.length === 0) return { symbols: all, subset: false };
  const want = new Set(requested.map((s) => String(s).toUpperCase()));
  return { symbols: all.filter((s) => want.has(s)), subset: true };
}
