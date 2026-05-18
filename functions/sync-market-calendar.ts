// Edge function: sync market_holidays from Alpaca's authoritative trading
// calendar. Pulls the trading-day list for a date window, then writes the
// *gaps* (weekday non-trading days + half-days) into market_holidays.
//
// Why this exists on top of the static migration seed:
//   - Static seed handles the known annual holidays (NYE, MLK, ..., Christmas).
//   - Alpaca's calendar is the authoritative source for *unexpected* closures
//     — hurricane Sandy (2012), 9/11, day-of-mourning for a former president,
//     etc. — that the static seed cannot anticipate. Periodic sync keeps the
//     table honest.
//
// The function never *deletes* rows: it only adds and updates. If the static
// seed contains an incorrect future holiday and Alpaca disagrees, fix it in
// a follow-up migration. Conservative on purpose — we'd rather mistakenly
// skip a worker than mistakenly run one when Alpaca says the market is shut.
//
// Cadence: weekly is plenty for routine refreshes; daily is safer when an
// unexpected closure may be imminent. The schedule is declared in
// schedules/schedules.yml and applied via the InsForge schedules API.
//
// Auth: X-Schedule-Secret. Optional body params:
//   - lookback (days, default 14): refresh recent history
//   - lookahead (days, default 400): how far forward to sync

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

const ALPACA_TRADING = "https://paper-api.alpaca.markets";
const PUBLIC_HOST = Deno.env.get("INSFORGE_BASE_URL") ?? "";

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_LOOKAHEAD_DAYS = 400;
const MAX_TOTAL_DAYS = 1825; // ~5y guardrail.

interface AlpacaCalendarRow {
  date: string;   // "YYYY-MM-DD" (ET)
  open: string;   // "HH:MM" ET wall-clock, e.g. "09:30"
  close: string;  // "HH:MM" ET wall-clock, e.g. "16:00" (or "13:00" half-day)
}

interface HolidayRow {
  date: string;
  name: string;
  early_close_et: string | null; // "HH:MM:SS" or null
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function dbUpsert(table: string, apiKey: string, rows: any[]): Promise<void> {
  const res = await fetch(`${PUBLIC_HOST}/api/database/records/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // ignore-duplicates instead of merge-duplicates: the static seed has
      // human-friendly names ("Day After Thanksgiving") that we'd rather not
      // overwrite with the placeholder "Half-day (Alpaca-detected)" label.
      // Trade-off: if a seed row is wrong, manual cleanup is required.
      Prefer: "return=minimal,resolution=ignore-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`db upsert ${table} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
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

    const alpacaKey = Deno.env.get("ALPACA_API_KEY") ?? "";
    const alpacaSecret = Deno.env.get("ALPACA_API_SECRET") ?? "";
    const apiKey = Deno.env.get("API_KEY") ?? "";
    if (!alpacaKey || alpacaKey === "PLACEHOLDER_REPLACE_ME") {
      return new Response(JSON.stringify({ error: "Alpaca creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "InsForge API_KEY not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const windowStart = addDays(today, -lookback);
    const windowEnd = addDays(today, lookahead);

    const url =
      `${ALPACA_TRADING}/v2/calendar?start=${ymd(windowStart)}&end=${ymd(windowEnd)}`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": alpacaKey,
        "APCA-API-SECRET-KEY": alpacaSecret,
      },
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      return new Response(JSON.stringify({ error: `Alpaca ${res.status}: ${text}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const tradingDays = (await res.json()) as AlpacaCalendarRow[];
    if (!Array.isArray(tradingDays)) {
      return new Response(JSON.stringify({ error: "Alpaca response not an array" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Index Alpaca's trading days for O(1) lookup, and pull half-day info
    // from the same pass.
    const byDate = new Map<string, AlpacaCalendarRow>();
    for (const row of tradingDays) {
      if (row?.date) byDate.set(row.date, row);
    }

    // Sweep every weekday in the window. Days absent from Alpaca = closure;
    // days present with close < "16:00" = half-day.
    const holidayUpserts: HolidayRow[] = [];
    for (let cursor = new Date(windowStart); cursor <= windowEnd; cursor = addDays(cursor, 1)) {
      const date = ymd(cursor);
      const dow = cursor.getUTCDay();
      if (dow === 0 || dow === 6) continue; // weekends are the default rule.
      const row = byDate.get(date);
      if (!row) {
        // Weekday absent from Alpaca → market closed.
        holidayUpserts.push({
          date,
          name: "Closure (Alpaca-detected)",
          early_close_et: null,
        });
      } else if (row.close < "16:00") {
        // Half-day. Store the close time as ET wall-clock (HH:MM:SS).
        holidayUpserts.push({
          date,
          name: "Half-day (Alpaca-detected)",
          early_close_et: `${row.close}:00`,
        });
      }
    }

    // Batched upsert. Small payloads (typically <30 rows), but keep the loop
    // for safety on big backfills.
    const upsertFailures: { batchStart: number; error: string }[] = [];
    let upserted = 0;
    if (holidayUpserts.length > 0) {
      for (let i = 0; i < holidayUpserts.length; i += 200) {
        const batch = holidayUpserts.slice(i, i + 200);
        try {
          await dbUpsert("market_holidays", apiKey, batch);
          upserted += batch.length;
        } catch (e: any) {
          upsertFailures.push({ batchStart: i, error: String(e?.message ?? e).slice(0, 200) });
        }
      }
    }

    return new Response(
      JSON.stringify({
        syncedAt: new Date().toISOString(),
        windowStart: ymd(windowStart),
        windowEnd: ymd(windowEnd),
        alpacaTradingDays: tradingDays.length,
        holidaysDetected: holidayUpserts.length,
        upserted,
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
