// Edge function: pull the Finnhub earnings calendar for a date window and
// upsert into earnings_dates. We scope to the symbols we already track in
// the `instruments` table (Finnhub returns the global US calendar — ~1000+
// rows per week — most of which are outside our universe).
//
// Two-pass fetch:
//  1. Global sweep, chunked into 7-day windows. Each /calendar/earnings call
//     is silently capped at ~1500 rows; 90 days in one call would truncate
//     to roughly the last 8 days. 7-day chunks fit under the cap.
//  2. Per-symbol fallback for any universe symbol the global sweep missed.
//     The global response drops some legitimate names (foreign-domiciled,
//     less liquid, etc.) presumably as part of the row-cap selection;
//     querying with ?symbol= surfaces them every time.
//
// ~13 sweep calls + up to ~100 fallback calls = comfortably under the free
// tier's 60/min limit when run once daily.

const FH_BASE = "https://finnhub.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

const DEFAULT_LOOKBACK_DAYS = 0;
const DEFAULT_LOOKAHEAD_DAYS = 95;
const CHUNK_DAYS = 7;
const MAX_TOTAL_DAYS = 1825; // ~5y guardrail for one-off backfills.

interface FinnhubRow {
  date?: string;
  symbol?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
}

interface EarningsRow {
  symbol: string;
  date: string;
  eps_estimate: number | null;
  eps_actual: number | null;
  revenue_estimate: number | null;
  revenue_actual: number | null;
}

function mapRow(r: FinnhubRow): EarningsRow | null {
  if (!r?.symbol || !r?.date) return null;
  return {
    symbol: r.symbol,
    date: r.date,
    eps_estimate: r.epsEstimate ?? null,
    eps_actual: r.epsActual ?? null,
    revenue_estimate: r.revenueEstimate ?? null,
    revenue_actual: r.revenueActual ?? null,
  };
}

// Free-tier ceiling is 60 calls/min. Empirically Finnhub silently returns
// 200 + empty earningsCalendar (rather than 429) when over-rate, so paced
// sequential calls are the only reliable way to avoid phantom misses.
const FH_MIN_GAP_MS = 250;
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

async function dbUpsert(baseUrl: string, apiKey: string, table: string, rows: any[]): Promise<void> {
  const res = await fetch(`${baseUrl}/api/database/records/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`db upsert ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    const body = await req.json().catch(() => ({}));
    const lookback = Math.min(
      Math.max(0, Number(body?.lookback ?? DEFAULT_LOOKBACK_DAYS)),
      MAX_TOTAL_DAYS,
    );
    const lookahead = Math.min(
      Math.max(0, Number(body?.lookahead ?? DEFAULT_LOOKAHEAD_DAYS)),
      MAX_TOTAL_DAYS,
    );

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

    // Symbol universe: every row in instruments.
    const instRows: any[] = await dbGet(
      baseUrl,
      apiKey,
      `instruments?select=symbol&limit=1000`,
    );
    const universe = new Set<string>(instRows.map((r) => r.symbol));
    if (universe.size === 0) {
      return new Response(JSON.stringify({ error: "no symbols in instruments table" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const windowStart = addDays(today, -lookback);
    const windowEnd = addDays(today, lookahead);

    // Chunk into 7-day windows. Finnhub silently caps each response at
    // ~1500 rows; the global US calendar fits inside that for one week but
    // not two.
    const chunks: { from: string; to: string }[] = [];
    let cursor = new Date(windowStart);
    while (cursor < windowEnd) {
      const next = addDays(cursor, CHUNK_DAYS);
      const to = next < windowEnd ? next : windowEnd;
      chunks.push({ from: ymd(cursor), to: ymd(to) });
      cursor = addDays(to, 1);
    }

    const allRows: EarningsRow[] = [];
    const fetchFailures: { context: string; error: string }[] = [];
    let rawRowCount = 0;

    // Pass 1 — global sweep. Sequential to respect the 60/min free-tier
    // ceiling without bookkeeping.
    for (const c of chunks) {
      const url =
        `${FH_BASE}/api/v1/calendar/earnings?from=${c.from}&to=${c.to}&token=${encodeURIComponent(fhKey)}`;
      try {
        const data = await finnhubFetch(url);
        const rows = Array.isArray(data?.earningsCalendar) ? (data.earningsCalendar as FinnhubRow[]) : [];
        rawRowCount += rows.length;
        for (const r of rows) {
          if (!r?.symbol || !universe.has(r.symbol)) continue;
          const mapped = mapRow(r);
          if (mapped) allRows.push(mapped);
        }
      } catch (e: any) {
        fetchFailures.push({
          context: `sweep ${c.from}..${c.to}`,
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
    }

    // Pass 2 — per-symbol fallback. Finnhub's global calendar drops some
    // legitimate names (esp. foreign-domiciled like ASML/LIN/TRI and a
    // sprinkle of US large caps like AMD/REGN). The same endpoint with
    // ?symbol= surfaces them.
    const fromYmd = ymd(windowStart);
    const toYmd = ymd(windowEnd);
    const covered = new Set(allRows.map((r) => r.symbol));
    const missing = [...universe].filter((s) => !covered.has(s));
    let fallbackHits = 0;
    for (const sym of missing) {
      const url =
        `${FH_BASE}/api/v1/calendar/earnings?from=${fromYmd}&to=${toYmd}` +
        `&symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(fhKey)}`;
      try {
        const data = await finnhubFetch(url);
        const rows = Array.isArray(data?.earningsCalendar) ? (data.earningsCalendar as FinnhubRow[]) : [];
        for (const r of rows) {
          // Finnhub echoes foreign-listed symbols with an exchange suffix
          // (e.g. `ASML.AS`, `FER.MC`, `TRI.TO`) even when queried by the
          // bare ticker. Accept either form, then store under our canonical
          // universe symbol so it joins back to the instruments table.
          if (!r?.symbol) continue;
          if (r.symbol !== sym && !r.symbol.startsWith(`${sym}.`)) continue;
          const mapped = mapRow({ ...r, symbol: sym });
          if (mapped) {
            allRows.push(mapped);
            fallbackHits++;
          }
        }
      } catch (e: any) {
        fetchFailures.push({
          context: `fallback ${sym}`,
          error: String(e?.message ?? e).slice(0, 200),
        });
      }
    }

    // De-dupe on (symbol, date) defensively.
    const seen = new Set<string>();
    const unique: EarningsRow[] = [];
    for (const r of allRows) {
      const k = `${r.symbol}|${r.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }

    // Upsert in batches of 500 (matches fetch-daily-bars pattern).
    const upsertFailures: { batchStart: number; error: string }[] = [];
    const upsertPromises: Promise<void>[] = [];
    for (let i = 0; i < unique.length; i += 500) {
      const start = i;
      const batch = unique.slice(start, start + 500);
      upsertPromises.push(
        dbUpsert(baseUrl, apiKey, "earnings_dates", batch).catch((e: any) => {
          upsertFailures.push({ batchStart: start, error: String(e?.message ?? e).slice(0, 200) });
        }),
      );
    }
    await Promise.all(upsertPromises);

    return new Response(
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        windowStart: ymd(windowStart),
        windowEnd: ymd(windowEnd),
        chunks: chunks.length,
        rawRowsScanned: rawRowCount,
        fallbackSymbols: missing.length,
        fallbackHits,
        rowsUpserted: unique.length,
        symbolsCovered: new Set(unique.map((r) => r.symbol)).size,
        fetchFailures,
        upsertFailures,
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
