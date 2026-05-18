// Edge function: fetch the latest 1-minute bars for the NDX-100 universe and
// upsert into minute_bars. One batched Alpaca multi-symbol bars call per
// tick covers ~100 symbols, well under the 200/min free-tier cap.
//
// Idempotent — `(symbol, ts)` is the PK and we upsert with merge-duplicates,
// so reruns within the same minute are safe. We pull a small lookback
// window (default 5 minutes) so a single missed tick still backfills on the
// next run.

const ALPACA_DATA = "https://data.alpaca.markets";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

const LOOKBACK_MINUTES = 5;

interface BarRow {
  symbol: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Retries on 429 (rate limit) AND 5xx (transient upstream errors). Without
// 5xx retry, a brief Alpaca hiccup during a cron tick was enough to lose
// that minute of bars across all NDX-100 symbols (the function returned
// 500 and no rows landed). Caught us on 2026-05-12T14:34Z–15:33Z.
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
    // 600ms, 1.2s, 2.4s — total budget ~4s before giving up.
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

// Walks Alpaca's paginated multi-symbol bars response. Shape:
// { bars: { AAPL: [{...}], MSFT: [{...}], ... }, next_page_token: "..." }
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
  const maxPages = 8; // ~8 * 1000 = 8000 bars; 100 symbols * 5 min = 500 max
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

function isMarketOpen(now: Date = new Date()): { open: boolean; reason?: string; etTime: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = parts.weekday;
  const etTime = `${parts.weekday} ${parts.hour}:${parts.minute} ET`;
  if (weekday === "Sat" || weekday === "Sun") return { open: false, reason: "weekend", etTime };
  const minutes = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutes < open) return { open: false, reason: "pre-market", etTime };
  if (minutes >= close) return { open: false, reason: "after-hours", etTime };
  return { open: true, etTime };
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
    const force = body?.force === true;
    const market = isMarketOpen();
    if (!market.open && !force) {
      return new Response(
        JSON.stringify({ skipped: true, reason: market.reason, etTime: market.etTime }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();

    // Holiday gate. Default: open Mon-Fri. Skip on weekends and on the
    // ~12 market_holidays rows per year where early_close_et IS NULL.
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

    // Pull the last LOOKBACK_MINUTES of bars. Alpaca often lags by ~15s on
    // the IEX feed, so subtracting 90s from `end` keeps us inside what's
    // actually published. The PK dedupes overlapping rows from prior ticks.
    const end = new Date(Date.now() - 90_000);
    const start = new Date(end.getTime() - LOOKBACK_MINUTES * 60_000);

    const bars = await fetchMinuteBars(symbols, start, end, alpacaKey, alpacaSecret);

    // Upsert in chunks to keep payload size manageable; minute bars are
    // small (~120 bytes each serialized) so 500/chunk is fine.
    const upsertFailures: { batchStart: number; error: string }[] = [];
    const upsertPromises: Promise<void>[] = [];
    for (let i = 0; i < bars.length; i += 500) {
      const start = i;
      const batch = bars.slice(start, start + 500);
      upsertPromises.push(
        dbUpsert(baseUrl, apiKey, "minute_bars", batch).catch((e: any) => {
          upsertFailures.push({ batchStart: start, error: String(e?.message ?? e).slice(0, 200) });
        }),
      );
    }
    await Promise.all(upsertPromises);

    return new Response(
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        symbolsRequested: symbols.length,
        barsStored: bars.length,
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
