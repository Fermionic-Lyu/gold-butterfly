// Edge function: pull market cap and trailing P/E for every symbol in the
// `instruments` table from Finnhub's /stock/metric endpoint and patch the
// row. Designed for a daily schedule — both numbers move with price (cap)
// and earnings (P/E denominator), so a once-a-day refresh is plenty.
//
// Finnhub returns marketCapitalization in MILLIONS of dollars; we store
// actual dollars in NUMERIC so the frontend formatter can render compact
// suffixes ($2.5T, etc.) without further unit math.
//
// Finnhub's free tier is 60 calls/min, so we pace at 1100ms between calls
// (see FH_MIN_GAP_MS). ~100 sequential calls finish in ~110s. Symbols
// Finnhub doesn't cover (some foreign ADRs on lower tiers) get NULL — the
// dashboard hides those metric cards.

const FH_BASE = "https://finnhub.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

// Finnhub free tier is 60 calls/min. 100 sequential calls at 1100ms each
// keeps us safely under, runs in ~110s.
const FH_MIN_GAP_MS = 1100;
let fhLastCallAt = 0;

async function finnhubFetch(url: string, attempt = 0): Promise<any> {
  const since = Date.now() - fhLastCallAt;
  if (since < FH_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, FH_MIN_GAP_MS - since));
  }
  fhLastCallAt = Date.now();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429 && attempt < 3) {
    const delay = 1200 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    return finnhubFetch(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Finnhub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function dbHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Prefer: "return=representation",
  };
}

async function dbGet(baseUrl: string, apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/records/${path}`, {
    headers: dbHeaders(apiKey),
  });
  if (!res.ok) throw new Error(`db get ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function dbPatch(
  baseUrl: string,
  apiKey: string,
  table: string,
  filter: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/database/records/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`db patch ${table} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function pickPe(metric: Record<string, unknown>): number | null {
  // Prefer trailing-twelve-month — that's the canonical "current" P/E. Fall
  // back to a normalized annual when TTM is missing (newer listings, etc).
  const candidates = ["peTTM", "peInclExtraTTM", "peNormalizedAnnual", "peAnnual"];
  for (const k of candidates) {
    const v = metric[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function pickMarketCap(metric: Record<string, unknown>): number | null {
  const v = metric.marketCapitalization;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v * 1_000_000; // Finnhub returns millions; store actual dollars.
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const expected = Deno.env.get("SCHEDULE_SECRET") ?? "";
  const provided = req.headers.get("X-Schedule-Secret") ?? "";
  if (!expected || expected !== provided) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const fhKey = Deno.env.get("FINNHUB_API_KEY") ?? "";
    const baseUrl = Deno.env.get("INSFORGE_BASE_URL") ?? "";
    const apiKey = Deno.env.get("API_KEY") ?? "";
    if (!fhKey || fhKey === "PLACEHOLDER_REPLACE_ME") {
      return new Response(JSON.stringify({ error: "FINNHUB_API_KEY not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();

    const instRows: any[] = await dbGet(
      baseUrl,
      apiKey,
      `instruments?select=symbol&limit=1000`,
    );
    const symbols: string[] = instRows.map((r) => r.symbol).sort();
    if (symbols.length === 0) {
      return new Response(JSON.stringify({ error: "no symbols in instruments table" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let mcapHits = 0;
    let peHits = 0;
    const fetchFailures: { symbol: string; error: string }[] = [];
    const patchFailures: { symbol: string; error: string }[] = [];

    for (const sym of symbols) {
      const url =
        `${FH_BASE}/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}` +
        `&metric=all&token=${encodeURIComponent(fhKey)}`;
      try {
        const data = await finnhubFetch(url);
        const metric = (data?.metric ?? {}) as Record<string, unknown>;
        const market_cap = pickMarketCap(metric);
        const pe_ratio = pickPe(metric);
        if (market_cap !== null) mcapHits++;
        if (pe_ratio !== null) peHits++;
        try {
          await dbPatch(baseUrl, apiKey, "instruments", `symbol=eq.${sym}`, {
            market_cap,
            pe_ratio,
          });
        } catch (e: any) {
          patchFailures.push({ symbol: sym, error: String(e?.message ?? e).slice(0, 200) });
        }
      } catch (e: any) {
        fetchFailures.push({ symbol: sym, error: String(e?.message ?? e).slice(0, 200) });
      }
    }

    return new Response(
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        symbolsRequested: symbols.length,
        marketCapHits: mcapHits,
        peHits,
        fetchFailures,
        patchFailures,
        elapsedMs: Date.now() - startedAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
