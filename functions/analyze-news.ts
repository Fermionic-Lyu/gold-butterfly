// Edge function: turn the day's freshly scraped news into a per-symbol
// digest. The Modal scraper (modal/scrape_news.py) writes raw articles into
// `company_news` and then POSTs this function; it also runs on a cron backstop
// (see schedules/schedules.mjs) in case that trigger is missed.
//
// For every symbol that has news scraped today, we hand the headlines +
// summaries (+ a slice of extracted body text) to an LLM via OpenRouter and
// ask for a strict-JSON read: coarse sentiment, a continuous score, a short
// summary, key bullet points, and — the angle that makes this useful inside an
// options sandbox — how the news might bear on implied vol / positioning. The
// result UPSERTs one row per (symbol, day) into `news_analyses`.
//
// Same auth model as the other scheduled functions: SCHEDULE_SECRET header.
// Same OpenRouter transport as strategy-analysis / trading-tick (npm:openai
// pointed at openrouter.ai, structured outputs via response_format).

import OpenAI from "npm:openai@^4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Schedule-Secret",
};

// Default digest model. Cheap-and-capable is the right tradeoff for a daily
// per-symbol summarization job; override per-call with body.model.
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

const NEWS_SCHEMA = {
  name: "news_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sentiment: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
      // Continuous read in [-1, 1]; -1 most bearish, +1 most bullish.
      sentiment_score: { type: "number" },
      summary: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      options_impact: { type: "string" },
    },
    required: ["sentiment", "sentiment_score", "summary", "key_points", "options_impact"],
  },
} as const;

const SYSTEM_PROMPT = `You are a financial-news analyst for an options-trading research sandbox.
Given a single company's news items for one day, produce a concise, neutral read:

- sentiment: overall tone toward the stock (bullish/bearish/neutral/mixed).
- sentiment_score: a number in [-1, 1] (-1 most bearish, +1 most bullish).
- summary: 2-4 sentences capturing what actually happened today. No fluff.
- key_points: 2-5 short bullets (catalysts, themes, risks). Each under ~15 words.
- options_impact: 1-3 sentences on how this news might affect implied volatility,
  skew, or options positioning (e.g. earnings/catalyst proximity, vol expansion
  vs. crush). Be specific but hedged.

Ground every claim in the provided items. Do not invent facts or numbers. This
is educational analysis, not financial advice.`;

function dbHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function dbGet(baseUrl: string, apiKey: string, path: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/database/records/${path}`, {
    headers: dbHeaders(apiKey),
  });
  if (!res.ok) throw new Error(`db get ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function dbUpsert(
  baseUrl: string,
  apiKey: string,
  table: string,
  onConflict: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/database/records/${table}?on_conflict=${onConflict}`,
    {
      method: "POST",
      headers: {
        ...dbHeaders(apiKey),
        Prefer: "return=minimal,resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`db upsert ${table} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

interface NewsItem {
  symbol: string;
  source: string;
  headline: string;
  summary: string | null;
  full_text: string | null;
  url: string;
  published_at: string | null;
}

// Compact, token-bounded rendering of one symbol's day of news for the prompt.
function renderItems(items: NewsItem[]): string {
  return items
    .slice(0, 15)
    .map((it, i) => {
      const parts = [`[${i + 1}] (${it.source}) ${it.headline}`];
      if (it.summary) parts.push(`    summary: ${it.summary.slice(0, 400)}`);
      if (it.full_text) parts.push(`    body: ${it.full_text.slice(0, 1200)}`);
      return parts.join("\n");
    })
    .join("\n\n");
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
    const baseUrl = Deno.env.get("INSFORGE_BASE_URL") ?? "";
    const apiKey = Deno.env.get("API_KEY") ?? "";
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ error: "InsForge creds not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!openrouterKey) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const model = (body?.model ?? "").toString() || DEFAULT_MODEL;
    // Which day to summarize. Defaults to today (UTC), matching the scraper's
    // scraped_at; override with body.date ("YYYY-MM-DD") for re-runs.
    const asOfDate = (body?.date ?? "").toString().match(/^\d{4}-\d{2}-\d{2}$/)
      ? body.date
      : new Date().toISOString().slice(0, 10);
    const dayStart = `${asOfDate}T00:00:00Z`;

    // Pull everything scraped on/after the day's start and bucket by symbol.
    const rows: NewsItem[] = await dbGet(
      baseUrl,
      apiKey,
      `company_news?select=symbol,source,headline,summary,full_text,url,published_at` +
        `&scraped_at=gte.${encodeURIComponent(dayStart)}&order=symbol.asc,published_at.desc&limit=5000`,
    );

    const bySymbol = new Map<string, NewsItem[]>();
    for (const r of rows) {
      const arr = bySymbol.get(r.symbol) ?? [];
      arr.push(r);
      bySymbol.set(r.symbol, arr);
    }

    if (bySymbol.size === 0) {
      return new Response(
        JSON.stringify({ asOfDate, symbolsAnalyzed: 0, note: "no news scraped for this day yet" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const llm = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      timeout: 600_000,
    });

    const startedAt = Date.now();
    let analyzed = 0;
    const failures: { symbol: string; error: string }[] = [];

    // Sequential to keep OpenRouter usage predictable on a daily batch.
    for (const [symbol, items] of bySymbol) {
      const userMsg = `Company: ${symbol}\nDate: ${asOfDate}\nArticle count: ${items.length}\n\nNews items:\n${renderItems(items)}\n\nReturn the JSON object specified by the schema.`;
      try {
        let parsed: any = null;
        for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
          const resp = await llm.chat.completions.create({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg },
            ],
            temperature: 0.2,
            max_tokens: 900,
            response_format: { type: "json_schema", json_schema: NEWS_SCHEMA },
          });
          try {
            parsed = JSON.parse(resp?.choices?.[0]?.message?.content ?? "");
          } catch {
            parsed = null;
          }
        }
        if (parsed === null) {
          failures.push({ symbol, error: "LLM returned unparseable output" });
          continue;
        }
        await dbUpsert(baseUrl, apiKey, "news_analyses", "symbol,as_of_date", [
          {
            symbol,
            as_of_date: asOfDate,
            sentiment: parsed.sentiment,
            sentiment_score: parsed.sentiment_score,
            summary: parsed.summary,
            key_points: parsed.key_points ?? [],
            options_impact: parsed.options_impact ?? null,
            article_count: items.length,
            model,
          },
        ]);
        analyzed++;
      } catch (e: any) {
        failures.push({ symbol, error: String(e?.message ?? e).slice(0, 200) });
      }
    }

    return new Response(
      JSON.stringify({
        asOfDate,
        symbolsWithNews: bySymbol.size,
        symbolsAnalyzed: analyzed,
        failures,
        model,
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
