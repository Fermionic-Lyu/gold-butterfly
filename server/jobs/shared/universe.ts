import { query } from "../../db.ts";

export async function ndxSymbols(): Promise<string[]> {
  const rows = await query<{ symbol: string }>(
    "SELECT symbol FROM instruments WHERE indices @> ARRAY['NDX'] ORDER BY symbol",
  );
  return rows.map((r) => r.symbol);
}

export async function allInstruments(): Promise<{ symbol: string; name: string }[]> {
  return query("SELECT symbol, name FROM instruments ORDER BY symbol");
}
