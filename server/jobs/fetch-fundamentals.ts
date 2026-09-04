// Market cap and trailing P/E per instrument from Finnhub /stock/metric.
// Finnhub reports market cap in millions; we store dollars.

import { execute, query } from "../db.ts";
import { FH_BASE, finnhubFetch, requireFinnhub, withToken } from "./shared/finnhub.ts";
import { errMsg } from "./shared/util.ts";

// 100 sequential calls at 1100ms keeps the free tier's 60/min happy.
const FH_MIN_GAP_MS = 1100;

function pickPe(metric: Record<string, unknown>): number | null {
  for (const k of ["peTTM", "peInclExtraTTM", "peNormalizedAnnual", "peAnnual"]) {
    const v = metric[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function pickMarketCap(metric: Record<string, unknown>): number | null {
  const v = metric.marketCapitalization;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1_000_000 : null;
}

export async function fetchFundamentals() {
  requireFinnhub();
  const startedAt = Date.now();
  const symbols = (await query<{ symbol: string }>("SELECT symbol FROM instruments ORDER BY symbol")).map(
    (r) => r.symbol,
  );
  if (symbols.length === 0) throw new Error("no symbols in instruments table");

  let mcapHits = 0;
  let peHits = 0;
  const fetchFailures: { symbol: string; error: string }[] = [];
  for (const sym of symbols) {
    try {
      const data = await finnhubFetch(
        withToken(`${FH_BASE}/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`),
        FH_MIN_GAP_MS,
      );
      const metric = (data?.metric ?? {}) as Record<string, unknown>;
      const market_cap = pickMarketCap(metric);
      const pe_ratio = pickPe(metric);
      if (market_cap !== null) mcapHits++;
      if (pe_ratio !== null) peHits++;
      await execute(
        "UPDATE instruments SET market_cap = $1, pe_ratio = $2, updated_at = now() WHERE symbol = $3",
        [market_cap, pe_ratio, sym],
      );
    } catch (e) {
      fetchFailures.push({ symbol: sym, error: errMsg(e, 200) });
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    symbolsRequested: symbols.length,
    marketCapHits: mcapHits,
    peHits,
    fetchFailures,
    elapsedMs: Date.now() - startedAt,
  };
}
