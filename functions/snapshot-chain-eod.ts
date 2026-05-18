// Edge function: end-of-day archival of the live chain state into the
// normalized chain_*_history tables. Runs once per US trading weekday
// after the close.
//
// The actual archival is one SQL statement (a `archive_chain_eod` RPC
// in the database): two `INSERT INTO ... SELECT FROM chain_quotes /
// chain_underlyings` statements inside a single transaction. **No chain
// data ever flows through PostgREST or this edge function** — the
// function's job is just to (a) check whether today is a trading day
// and (b) call the RPC with today's ET date.
//
// Skips on weekends and on market_holidays full-closure dates so we
// don't archive yesterday's chain under today's date.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

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
  if (!res.ok) {
    throw new Error(`db get ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function dbRpc(
  baseUrl: string,
  apiKey: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`rpc ${fn} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// ET calendar date (YYYY-MM-DD), DST-aware. The archival is stamped with
// today's ET date — at 22:05 UTC = 18:05 EDT / 17:05 EST, "today in ET"
// is the same as the trading day whose close we're archiving.
function etTodayDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
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

    const baseUrl = Deno.env.get("INSFORGE_BASE_URL") ?? "";
    const apiKey = Deno.env.get("API_KEY") ?? "";
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startedAt = Date.now();
    const runDate = etTodayDate();

    // Trading-day gate. Default: open Mon-Fri. Exception: market_holidays
    // (full-closure rows skip; half-day rows proceed).
    if (!force) {
      const dow = new Date(`${runDate}T12:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "weekend", runDate }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const holidays: { early_close_et: string | null }[] = await dbGet(
        baseUrl,
        apiKey,
        `market_holidays?date=eq.${runDate}&select=early_close_et&limit=1`,
      );
      if (holidays.length > 0 && holidays[0].early_close_et === null) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "holiday — full closure", runDate }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // One RPC. Two INSERT INTO ... SELECT statements run inside Postgres
    // in a single transaction. Zero chain data crosses the network from
    // this function or through PostgREST request bodies.
    const result = await dbRpc(baseUrl, apiKey, "archive_chain_eod", {
      run_date: runDate,
    });

    return new Response(
      JSON.stringify({
        runDate,
        archived: result,
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
