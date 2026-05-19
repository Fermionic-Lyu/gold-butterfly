// Edge function: fetch full option chains for the Nasdaq-100 every 2 min
// and write them into the normalized chain_quotes + chain_underlyings
// tables. Consumers (Dashboard, agent worker) read from those
// tables directly — no big-JSONB blob in the hot path, no TOAST churn,
// no PostgREST memory pressure under burst. ~97K small per-contract
// rows are upserted in ~390 small chunks rather than 20 fat ~400 KB
// chunks (the old chain_snapshots pattern was OOM-restarting PostgREST).
//
// Per tick we do 1 batched spot-quote call + ~100 chain calls (one per
// symbol, paginated). HV30 is intentionally NOT included here (changes
// daily, not minute-by-minute); fetch-daily-bars populates it on
// instruments.hv30 after the close.

const ALPACA_DATA = "https://data.alpaca.markets";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

// Strike-band fraction and horizon match the live options-chain function so
// downstream consumers see equivalent payloads.
const STRIKE_BAND_FRACTION = 0.35;
const HORIZON_DAYS = 400;
// Pacing: 6 chain fetches in parallel with a 700ms pause between batches.
// Sustained rate ≈ 6 reqs / 1200ms ≈ 5 req/sec ≈ 300/min instantaneous, but
// only fires for ~25s per tick so the rolling 60-s budget stays well below
// Alpaca's 200/min cap (1 spot pair + 100 chains = ~102 calls/tick).
const PARALLEL_CHUNK = 6;
const INTER_BATCH_DELAY_MS = 700;

interface ChainContractOut {
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

interface SnapshotPayload {
  symbol: string;
  underlying: { price: number | null; source: string; timestamp: string | null };
  expirations: string[];
  contracts: ChainContractOut[];
  contractCount: number;
  strikeBand: { min: number | null; max: number | null; fraction: number };
  horizonDays: number;
  realizedVol: null;
  fetchedAt: string;
}

interface IvSnapshotRow {
  symbol: string;
  captured_at: string;
  spot: number | null;
  atm_iv: number | null;
  atm_call_iv: number | null;
  atm_put_iv: number | null;
  primary_expiration: string | null;
  primary_dte: number | null;
  hv30: null;
}

// Derive an ATM IV summary from a chain payload we just fetched. Picks the
// expiration closest to 30 DTE and the call/put with strike nearest spot
// inside that expiration. Pure in-memory work — replaces what
// snapshot-iv-mag7 used to fetch separately. Returns null if no usable
// contracts.
function deriveAtmSnapshot(
  symbol: string,
  spot: number,
  contracts: ChainContractOut[],
  capturedAt: string,
): IvSnapshotRow | null {
  if (contracts.length === 0) return null;
  const now = new Date(capturedAt).getTime();

  // Bucket by expiration, tracking the nearest-to-spot call and put.
  const byExp = new Map<
    string,
    { call?: ChainContractOut; put?: ChainContractOut; bestCallDiff: number; bestPutDiff: number }
  >();
  for (const c of contracts) {
    let bucket = byExp.get(c.expiration);
    if (!bucket) {
      bucket = { bestCallDiff: Infinity, bestPutDiff: Infinity };
      byExp.set(c.expiration, bucket);
    }
    const diff = Math.abs(c.strike - spot);
    if (c.type === "call" && diff < bucket.bestCallDiff) {
      bucket.call = c;
      bucket.bestCallDiff = diff;
    } else if (c.type === "put" && diff < bucket.bestPutDiff) {
      bucket.put = c;
      bucket.bestPutDiff = diff;
    }
  }

  // Pick the expiration with DTE closest to 30 (matching the prior
  // snapshot-iv-mag7 convention so series are continuous).
  let chosenExp: string | null = null;
  let chosenDiff = Infinity;
  for (const exp of byExp.keys()) {
    const days = (new Date(exp + "T16:00:00Z").getTime() - now) / 86_400_000;
    const d = Math.abs(days - 30);
    if (d < chosenDiff) {
      chosenDiff = d;
      chosenExp = exp;
    }
  }
  if (!chosenExp) return null;

  const bucket = byExp.get(chosenExp)!;
  const callIv = typeof bucket.call?.iv === "number" ? bucket.call.iv : null;
  const putIv = typeof bucket.put?.iv === "number" ? bucket.put.iv : null;
  if (callIv === null && putIv === null) return null;
  const atmIv =
    callIv !== null && putIv !== null ? (callIv + putIv) / 2 : (callIv ?? putIv);
  const dte = Math.round((new Date(chosenExp + "T16:00:00Z").getTime() - now) / 86_400_000);
  return {
    symbol,
    captured_at: capturedAt,
    spot,
    atm_iv: atmIv,
    atm_call_iv: callIv,
    atm_put_iv: putIv,
    primary_expiration: chosenExp,
    primary_dte: dte,
    hv30: null, // will be backfilled from daily_bars in a separate pass once that table exists
  };
}

// Retries on 429 AND 5xx — brief Alpaca upstream hiccups otherwise cost
// us a full tick of data across all NDX-100 symbols.
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

function parseOcc(occ: string): { type: "call" | "put"; strike: number; expiration: string } | null {
  const m = occ.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const ymd = m[1];
  return {
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: m[2] === "C" ? "call" : "put",
    strike: parseInt(m[3], 10) / 1000,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchSpotsBatch(
  symbols: string[],
  key: string,
  secret: string,
): Promise<Record<string, { price: number | null; source: string; timestamp: string | null }>> {
  // Two batched calls: latest trade (prints) and latest quote (NBBO). Many
  // symbols have one but not the other on the free IEX feed, so we merge —
  // preferring the trade, falling back to the quote midpoint.
  const csv = symbols.join(",");
  const [trades, quotes] = await Promise.all([
    alpacaFetch(`${ALPACA_DATA}/v2/stocks/trades/latest?symbols=${csv}&feed=iex`, key, secret).catch(() => null),
    alpacaFetch(`${ALPACA_DATA}/v2/stocks/quotes/latest?symbols=${csv}&feed=iex`, key, secret).catch(() => null),
  ]);
  const out: Record<string, { price: number | null; source: string; timestamp: string | null }> = {};
  for (const sym of symbols) {
    const t = trades?.trades?.[sym];
    if (t && typeof t.p === "number" && t.p > 0) {
      out[sym] = { price: t.p, source: "trade", timestamp: t.t ?? null };
      continue;
    }
    const q = quotes?.quotes?.[sym];
    if (q && typeof q.bp === "number" && typeof q.ap === "number" && q.bp > 0 && q.ap > 0) {
      out[sym] = { price: (q.bp + q.ap) / 2, source: "quote-mid", timestamp: q.t ?? null };
      continue;
    }
    out[sym] = { price: null, source: "unavailable", timestamp: null };
  }
  return out;
}

async function fetchChainForSymbol(
  symbol: string,
  spot: number,
  key: string,
  secret: string,
): Promise<{ contracts: ChainContractOut[]; expirations: string[]; band: { min: number; max: number } }> {
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);
  const band = spot * STRIKE_BAND_FRACTION;
  const strikeMin = Math.max(0, spot - band);
  const strikeMax = spot + band;

  const all: Record<string, any> = {};
  let pageToken: string | undefined;
  let pages = 0;
  const maxPages = 5; // 5 × 1000 = 5000 contracts cap, plenty for any single name
  do {
    const url = new URL(`${ALPACA_DATA}/v1beta1/options/snapshots/${symbol}`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("strike_price_gte", strikeMin.toFixed(2));
    url.searchParams.set("strike_price_lte", strikeMax.toFixed(2));
    url.searchParams.set("expiration_date_lte", isoDate(horizon));
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await alpacaFetch(url.toString(), key, secret);
    if (data?.snapshots) Object.assign(all, data.snapshots);
    pageToken = data?.next_page_token;
    pages++;
  } while (pageToken && pages < maxPages);

  const contracts: ChainContractOut[] = [];
  for (const [occ, snap] of Object.entries<any>(all)) {
    const p = parseOcc(occ);
    if (!p) continue;
    const q = snap?.latestQuote;
    const t = snap?.latestTrade;
    const g = snap?.greeks;
    // Cumulative day volume lives on snap.dailyBar.v. We previously read
    // t.s here, which is the size of the single latest trade — not what
    // anyone means by "volume". Keep that as a fallback for contracts
    // where the dailyBar field is missing.
    const d = snap?.dailyBar;
    contracts.push({
      symbol: occ,
      expiration: p.expiration,
      strike: p.strike,
      type: p.type,
      bid: q?.bp ?? null,
      ask: q?.ap ?? null,
      bidSize: q?.bs ?? null,
      askSize: q?.as ?? null,
      last: t?.p ?? null,
      iv: snap?.impliedVolatility ?? null,
      delta: g?.delta ?? null,
      gamma: g?.gamma ?? null,
      theta: g?.theta ?? null,
      vega: g?.vega ?? null,
      rho: g?.rho ?? null,
      openInterest: snap?.openInterest ?? null,
      volume: typeof d?.v === "number" ? d.v : t?.s ?? null,
      updated: q?.t ?? t?.t ?? null,
    });
  }
  const expirations = Array.from(new Set(contracts.map((c) => c.expiration))).sort();
  return { contracts, expirations, band: { min: strikeMin, max: strikeMax } };
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

// US equity regular session — same DST-aware check used in trading-tick.
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

// Service-role REST helpers for the InsForge DB.
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

async function dbUpsertOnce(baseUrl: string, apiKey: string, table: string, rows: any[]): Promise<void> {
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

// Retry wrapper for transient PostgREST/proxy errors. PostgREST briefly
// restarts under burst load (its container has a low memory ceiling that
// large-JSONB writes can cross), and during the ~1-2s restart window
// requests get back PGRST002 / 503 / ECONNREFUSED / EPIPE / ECONNRESET.
// Upserts are idempotent (PK + merge-duplicates), so retrying is safe.
// Three attempts with light exponential backoff covers ~6s of unavailability.
async function dbUpsert(
  baseUrl: string,
  apiKey: string,
  table: string,
  rows: any[],
): Promise<void> {
  // 401 AUTH_INVALID_API_KEY is normally fatal, but during a PostgREST
  // restart the platform's auth layer briefly returns it for valid keys —
  // we know the key is fine because most chunks in the same run succeed.
  // Treat it as transient.
  const RETRYABLE = /PGRST002|AUTH_INVALID_API_KEY|\b401\b|\b502\b|\b503\b|\b504\b|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|timeout/i;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await dbUpsertOnce(baseUrl, apiKey, table, rows);
      return;
    } catch (e) {
      lastErr = e;
      const msg = String((e as any)?.message ?? e);
      if (attempt < 3 && RETRYABLE.test(msg)) {
        // 500ms, 1500ms — total ~2s worst case before final attempt at +2s.
        await new Promise((r) => setTimeout(r, 500 * attempt + Math.random() * 500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function chunkedAll<T, R>(
  items: T[],
  size: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
    if (i + size < items.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
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

    // Get the universe — Nasdaq-100 from instruments table.
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

    // 1) Batch spot quotes for all symbols (1 Alpaca call).
    const spots = await fetchSpotsBatch(symbols, alpacaKey, alpacaSecret);

    // 2) Fetch chains in chunks. Each call counts toward the 200/min budget;
    // 8 in parallel finishes ~100 symbols in 12-15s wall-clock. Build
    // normalized rows in memory: chain_quotes (one per contract, ~120 B)
    // and chain_underlyings (one per symbol, metadata).
    const fetchedAt = new Date().toISOString();
    const failures: { symbol: string; error: string }[] = [];
    const underlyingRows: any[] = [];
    const quoteRows: any[] = [];
    const ivRows: IvSnapshotRow[] = [];

    // IV is captured on schedule (:00 / :30 minutes during market hours)
    // only. Manual force-refreshes for chain debugging do NOT write IV —
    // off-cadence force runs would pollute iv_snapshots with rows at random
    // minutes. Pass {"capture_iv": true} explicitly to override (testing).
    const captureMinute = new Date(fetchedAt).getUTCMinutes();
    const captureIv =
      captureMinute === 0 || captureMinute === 30 || body?.capture_iv === true;

    await chunkedAll(symbols, PARALLEL_CHUNK, INTER_BATCH_DELAY_MS, async (sym) => {
      const u = spots[sym];
      if (!u || u.price === null) {
        failures.push({ symbol: sym, error: "no spot" });
        return null;
      }
      try {
        const { contracts, expirations, band } = await fetchChainForSymbol(
          sym,
          u.price,
          alpacaKey,
          alpacaSecret,
        );
        underlyingRows.push({
          symbol: sym,
          spot: u.price,
          spot_source: u.source,
          spot_ts: u.timestamp,
          expirations,
          contract_count: contracts.length,
          strike_min: band.min,
          strike_max: band.max,
          fetched_at: fetchedAt,
        });
        for (const c of contracts) {
          quoteRows.push({
            underlying: sym,
            occ_symbol: c.symbol,
            expiration: c.expiration,
            strike: c.strike,
            type: c.type,
            bid: c.bid,
            ask: c.ask,
            bid_size: c.bidSize,
            ask_size: c.askSize,
            last: c.last,
            iv: c.iv,
            delta: c.delta,
            gamma: c.gamma,
            theta: c.theta,
            vega: c.vega,
            rho: c.rho,
            open_interest: c.openInterest,
            volume: c.volume,
            updated: c.updated,
            fetched_at: fetchedAt,
          });
        }
        if (captureIv) {
          const iv = deriveAtmSnapshot(sym, u.price, contracts, fetchedAt);
          if (iv) ivRows.push(iv);
        }
      } catch (e: any) {
        failures.push({ symbol: sym, error: String(e?.message ?? e).slice(0, 200) });
      }
      return null;
    });

    // 3) Normalized upserts. Per-contract rows are ~120 B (no TOAST), so we
    // can use bigger chunks (250 rows ≈ 30 KB POST body) and the proxy
    // doesn't choke. Bounded concurrency at 8 means peak in-flight body
    // data is 8 × 30 KB = 240 KB — well within any PostgREST budget.
    //
    // chain_underlyings (~100 rows, tiny) goes in a single request.
    const UPSERT_CONCURRENCY = 8;
    const QUOTES_PER_CHUNK = 250;
    const upsertFailures: { table: string; batchStart: number; error: string }[] = [];

    // 3a) chain_underlyings — one POST.
    let underlyingsStored = 0;
    if (underlyingRows.length > 0) {
      await dbUpsert(baseUrl, apiKey, "chain_underlyings", underlyingRows)
        .then(() => {
          underlyingsStored = underlyingRows.length;
        })
        .catch((e: any) => {
          upsertFailures.push({
            table: "chain_underlyings",
            batchStart: 0,
            error: String(e?.message ?? e).slice(0, 200),
          });
        });
    }

    // 3b) chain_quotes — chunked with bounded concurrency.
    const quoteBatches: { start: number; rows: any[] }[] = [];
    for (let i = 0; i < quoteRows.length; i += QUOTES_PER_CHUNK) {
      quoteBatches.push({ start: i, rows: quoteRows.slice(i, i + QUOTES_PER_CHUNK) });
    }
    for (let i = 0; i < quoteBatches.length; i += UPSERT_CONCURRENCY) {
      const phase = quoteBatches.slice(i, i + UPSERT_CONCURRENCY);
      await Promise.all(
        phase.map((c) =>
          dbUpsert(baseUrl, apiKey, "chain_quotes", c.rows).catch((e: any) => {
            upsertFailures.push({
              table: "chain_quotes",
              batchStart: c.start,
              error: String(e?.message ?? e).slice(0, 200),
            });
          }),
        ),
      );
    }

    // 3c) Stale-contract sweep: any chain_quotes row whose fetched_at is
    // older than this tick's fetched_at refers to a contract that fell out
    // of the universe (delisted strike, expired option, etc.). Bounded
    // cleanup so the table doesn't grow unbounded.
    const sweepRes = await fetch(
      `${baseUrl}/api/database/records/chain_quotes?fetched_at=lt.${encodeURIComponent(fetchedAt)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}`, Prefer: "return=minimal" },
      },
    ).catch(() => null);
    const sweepStatus = sweepRes?.status ?? null;

    // 4) IV snapshots — append-only, tiny rows, one POST.
    let ivInserted = 0;
    let ivError: string | null = null;
    if (ivRows.length > 0) {
      await dbUpsert(baseUrl, apiKey, "iv_snapshots", ivRows)
        .then(() => {
          ivInserted = ivRows.length;
        })
        .catch((e: any) => {
          ivError = String(e?.message ?? e).slice(0, 200);
        });
    }

    return new Response(
      JSON.stringify({
        capturedAt: fetchedAt,
        symbolsRequested: symbols.length,
        underlyingsStored,
        quoteRowsStored: quoteRows.length,
        quoteChunks: quoteBatches.length,
        sweepStatus,
        ivCaptured: captureIv,
        ivInserted,
        ivError,
        fetchFailures: failures,
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
