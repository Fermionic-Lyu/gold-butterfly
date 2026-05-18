// Edge function: one-off backfill for a specific minute_bars window.
// Single-purpose, not on any schedule — invoked manually when a gap is
// detected in the live fetch-minute-bars cron coverage.
//
// Why a separate function instead of putting backfill params on
// fetch-minute-bars: keeps the live cron function trivially simple
// (no body-param branching, no risk of polluting iv_snapshots or
// other side-effects) and makes recovery operations explicit.
//
// Body:
//   {
//     "start": "YYYY-MM-DDTHH:MM:SSZ",   // inclusive
//     "end":   "YYYY-MM-DDTHH:MM:SSZ"    // exclusive
//   }
// Auth: X-Schedule-Secret matching SCHEDULE_SECRET.
//
// Idempotent: minute_bars PK is (symbol, ts), upsert with merge-
// duplicates. Re-running over an already-populated window is safe.

const ALPACA_DATA = "https://data.alpaca.markets";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

interface BarRow {
  symbol: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function alpacaFetch(url: string, key: string, secret: string, attempt = 0): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
  });
  const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (transient && attempt < 3) {
    await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
    return alpacaFetch(url, key, secret, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function fetchMinuteBars(
  symbols: string[],
  start: Date,
  end: Date,
  key: string,
  secret: string,
): Promise<BarRow[]> {
  const out: BarRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  // 100 symbols × ~60 min × 1 bar each ≈ 6000 bars at most for a typical
  // gap-fill window. 1000/page → ~6 pages. Cap higher than that for
  // safety on bigger windows.
  const maxPages = 50;
  do {
    const url = new URL(`${ALPACA_DATA}/v2/stocks/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("end", end.toISOString());
    url.searchParams.set("limit", "1000");
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", "iex");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await alpacaFetch(url.toString(), key, secret);
    const bars = (data?.bars ?? {}) as Record<string, any[]>;
    for (const [sym, arr] of Object.entries(bars)) {
      if (!Array.isArray(arr)) continue;
      for (const b of arr) {
        if (typeof b?.t !== "string" || typeof b?.c !== "number") continue;
        out.push({
          symbol: sym,
          ts: b.t,
          open: Number(b.o),
          high: Number(b.h),
          low: Number(b.l),
          close: Number(b.c),
          volume: Number(b.v ?? 0),
        });
      }
    }
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < maxPages);
  return out;
}

function dbHeaders(apiKey: string, prefer = "return=minimal") {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Prefer: prefer,
  };
}

async function dbGet(baseUrl: string, apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/records/${path}`, {
    headers: dbHeaders(apiKey, "return=representation"),
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
    const startStr = body?.start as string | undefined;
    const endStr = body?.end as string | undefined;
    if (!startStr || !endStr) {
      return new Response(
        JSON.stringify({ error: "body must include start and end (ISO timestamps)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return new Response(
        JSON.stringify({ error: "invalid start/end" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const alpacaKey = Deno.env.get("ALPACA_API_KEY") ?? "";
    const alpacaSecret = Deno.env.get("ALPACA_API_SECRET") ?? "";
    const baseUrl = Deno.env.get("INSFORGE_BASE_URL") ?? "";
    const apiKey = Deno.env.get("API_KEY") ?? "";
    if (!alpacaKey || alpacaKey === "PLACEHOLDER_REPLACE_ME") {
      return new Response(JSON.stringify({ error: "Alpaca creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();
    const ndxRows: any[] = await dbGet(
      baseUrl,
      apiKey,
      `instruments?indices=cs.{NDX}&select=symbol&limit=200`,
    );
    const symbols: string[] = ndxRows.map((r) => r.symbol).sort();

    const bars = await fetchMinuteBars(symbols, start, end, alpacaKey, alpacaSecret);

    // Same bounded-concurrency pattern as fetch-chains, so we don't put
    // burst pressure on PostgREST.
    const UPSERT_CONCURRENCY = 8;
    const ROWS_PER_CHUNK = 500;
    const upsertFailures: { batchStart: number; error: string }[] = [];
    const batches: { start: number; rows: BarRow[] }[] = [];
    for (let i = 0; i < bars.length; i += ROWS_PER_CHUNK) {
      batches.push({ start: i, rows: bars.slice(i, i + ROWS_PER_CHUNK) });
    }
    for (let i = 0; i < batches.length; i += UPSERT_CONCURRENCY) {
      const phase = batches.slice(i, i + UPSERT_CONCURRENCY);
      await Promise.all(
        phase.map((b) =>
          dbUpsert(baseUrl, apiKey, "minute_bars", b.rows).catch((e: any) => {
            upsertFailures.push({ batchStart: b.start, error: String(e?.message ?? e).slice(0, 200) });
          }),
        ),
      );
    }

    return new Response(
      JSON.stringify({
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        symbolsRequested: symbols.length,
        barsStored: bars.length,
        chunkCount: batches.length,
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
