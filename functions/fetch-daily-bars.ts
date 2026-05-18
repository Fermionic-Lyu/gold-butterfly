// Edge function: fetch daily OHLCV bars for the NDX-100 universe and upsert
// into daily_bars. Single batched Alpaca multi-symbol bars call covers
// ~100 symbols. The scheduler fires once per weekday after the US close;
// the same endpoint with a larger `lookback` body param handles a one-off
// historical backfill.
//
// Idempotent — `(symbol, date)` is the PK and we upsert with
// merge-duplicates, so reruns within the same day overwrite cleanly. Pulls
// `lookback` calendar days prior to the current UTC date, so passing
// `lookback: 400` seeds ~1 year of trading days (252 of which are bars).

const ALPACA_DATA = "https://data.alpaca.markets";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

const DEFAULT_LOOKBACK_DAYS = 5;
const MAX_LOOKBACK_DAYS = 1825; // ~5y guardrail

interface BarRow {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Retries on 429 AND 5xx — transient Alpaca errors shouldn't fail a tick.
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
    const delay = 600 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    return alpacaFetch(url, key, secret, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Walks the paginated multi-symbol bars response. Shape:
// { bars: { AAPL: [{...}], MSFT: [{...}], ... }, next_page_token: "..." }
async function fetchDailyBars(
  symbols: string[],
  startDate: string,
  endDate: string,
  key: string,
  secret: string,
): Promise<BarRow[]> {
  const out: BarRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  // Worst-case 100 symbols × 1260 days (5y) = 126k bars; at 1000/page that's
  // 126 pages. Cap higher than chain refresh since this is only one-off
  // backfills that need the headroom.
  const maxPages = 200;
  do {
    const url = new URL(`${ALPACA_DATA}/v2/stocks/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", startDate);
    url.searchParams.set("end", endDate);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("adjustment", "split");
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
          date: b.t.slice(0, 10),
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

// ET calendar date (YYYY-MM-DD), DST-aware. Used to key into market_calendar.
function etTodayDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
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

async function dbRpc(baseUrl: string, apiKey: string, fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`db rpc ${fn} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
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
    const force = body?.force === true;
    const lookback = Math.min(
      Math.max(1, Number(body?.lookback ?? DEFAULT_LOOKBACK_DAYS)),
      MAX_LOOKBACK_DAYS,
    );

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
    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();

    // Holiday gate. Default: open Mon-Fri. Skip on weekends and on the
    // ~12 market_holidays rows per year where early_close_et IS NULL.
    // Pass `force: true` to bypass for backfills.
    if (!force) {
      const todayEt = etTodayDate();
      const dow = new Date(`${todayEt}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "weekend", todayEt }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const holidays: { early_close_et: string | null }[] = await dbGet(
        baseUrl,
        apiKey,
        `market_holidays?date=eq.${todayEt}&select=early_close_et&limit=1`,
      ).catch(() => []);
      if (holidays.length > 0 && holidays[0].early_close_et === null) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "holiday — full closure", todayEt }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Universe = NDX-100 from instruments.
    const ndxRows: any[] = await dbGet(
      baseUrl,
      apiKey,
      `instruments?indices=cs.{NDX}&select=symbol&limit=200`,
    );
    const symbols: string[] = ndxRows.map((r) => r.symbol).sort();
    if (symbols.length === 0) {
      return new Response(JSON.stringify({ error: "no NDX symbols in instruments table" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - lookback);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const bars = await fetchDailyBars(symbols, startDate, endDate, alpacaKey, alpacaSecret);

    // Upsert in chunks. ~120 bytes/row, 500/chunk = ~60KB per request — safe
    // through the proxy. Backfills (lookback=400) produce ~25k bars → 50
    // chunks, all run in parallel.
    const upsertFailures: { batchStart: number; error: string }[] = [];
    const upsertPromises: Promise<void>[] = [];
    for (let i = 0; i < bars.length; i += 500) {
      const start = i;
      const batch = bars.slice(start, start + 500);
      upsertPromises.push(
        dbUpsert(baseUrl, apiKey, "daily_bars", batch).catch((e: any) => {
          upsertFailures.push({ batchStart: start, error: String(e?.message ?? e).slice(0, 200) });
        }),
      );
    }
    await Promise.all(upsertPromises);

    // Recompute HV30 from the DB. Previously this function computed HV30
    // from just the bars it had in memory — which silently broke when the
    // cron ran with a short lookback (5 days < 11-close minimum →
    // every symbol got hv30=NULL). The recompute_hv30_for_ndx RPC reads
    // the trailing 31 closes per NDX symbol from daily_bars and updates
    // instruments.hv30 atomically.
    const hv30Result = await dbRpc(baseUrl, apiKey, "recompute_hv30_for_ndx", {});
    const hv30Updated = Array.isArray(hv30Result) ? hv30Result.length : 0;

    return new Response(
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        windowStart: startDate,
        windowEnd: endDate,
        lookbackDays: lookback,
        symbolsRequested: symbols.length,
        barsStored: bars.length,
        hv30Updated,
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
