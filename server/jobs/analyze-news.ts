// One LLM digest per (subscribed symbol, day) over the articles scraped today.
//   args: { date?: "YYYY-MM-DD", model?: string, force?: boolean }

import { pool, query } from "../db.ts";
import { chatJson, openrouterClient } from "./shared/llm.ts";
import { errMsg } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

const NEWS_SCHEMA = {
  name: "news_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sentiment: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
      sentiment_score: { type: "number" },
      summary: { type: "string" },
      key_points: { type: "array", items: { type: "string" } },
      options_impact: { type: "string" },
      upcoming_catalysts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            event: { type: "string" },
            date: { type: ["string", "null"] },
            type: {
              type: "string",
              enum: ["product", "regulatory", "legal", "guidance", "m_and_a", "analyst", "macro", "other"],
            },
            vol_impact: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["event", "date", "type", "vol_impact"],
        },
      },
    },
    required: ["sentiment", "sentiment_score", "summary", "key_points", "options_impact", "upcoming_catalysts"],
  },
};

const SYSTEM_PROMPT = `You are a financial-news analyst for an options-trading research sandbox.
Given a single company's news items for one day, produce a concise, neutral read:

- sentiment: overall tone toward the stock (bullish/bearish/neutral/mixed).
- sentiment_score: a number in [-1, 1] (-1 most bearish, +1 most bullish).
- summary: 2-4 sentences capturing what actually happened today. No fluff.
- key_points: 2-5 short bullets (catalysts, themes, risks). Each under ~15 words.
- options_impact: 1-3 sentences on how this news might affect implied volatility,
  skew, or options positioning (e.g. earnings/catalyst proximity, vol expansion
  vs. crush). Be specific but hedged.
- upcoming_catalysts: dated FUTURE events the articles point to that could move
  this stock — product launches and keynotes, court or regulatory decision dates,
  investor days, conferences, guidance updates, deal closings, index changes.
  Set date to YYYY-MM-DD when the articles state or clearly imply one, else null.
  Skip anything already past, skip routine earnings (tracked separately), and
  skip vague expectations with no event behind them. Empty array when there are
  none — do not invent a catalyst to fill it.

Ground every claim in the provided items. Do not invent facts or numbers. This
is educational analysis, not financial advice.`;

interface NewsRow {
  symbol: string;
  source: string;
  headline: string;
  summary: string | null;
  full_text: string | null;
  url: string;
  published_at: Date | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A model-supplied date is only useful if it parses and is still ahead; a past
// or malformed one becomes an undated catalyst rather than a false deadline.
function sanitizeCatalysts(raw: unknown, asOfDate: string) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw.slice(0, 6)) {
    const event = String(c?.event ?? "").trim().slice(0, 200);
    if (!event) continue;
    const d = String(c?.date ?? "");
    const date = DATE_RE.test(d) && !Number.isNaN(Date.parse(d)) && d >= asOfDate ? d : null;
    out.push({
      event,
      date,
      type: String(c?.type ?? "other"),
      vol_impact: ["high", "medium", "low"].includes(c?.vol_impact) ? c.vol_impact : "medium",
    });
  }
  return out;
}

function renderItems(items: NewsRow[]): string {
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

export async function analyzeNews(args: JobArgs) {
  const llm = openrouterClient();
  const model = String(args.model ?? "") || DEFAULT_MODEL;
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? ""))
    ? String(args.date)
    : new Date().toISOString().slice(0, 10);
  const dayStart = `${asOfDate}T00:00:00Z`;
  const force = args.force === true;
  const startedAt = Date.now();

  const subscribed = (await query<{ symbol: string }>("SELECT DISTINCT symbol FROM subscriptions")).map(
    (r) => r.symbol,
  );
  if (subscribed.length === 0) return { asOfDate, symbolsAnalyzed: 0, note: "no subscribed symbols" };

  const alreadyDone = new Set(
    force
      ? []
      : (await query<{ symbol: string }>("SELECT symbol FROM news_analyses WHERE as_of_date = $1", [asOfDate])).map(
          (r) => r.symbol,
        ),
  );

  const rows = await query<NewsRow>(
    `SELECT symbol, source, headline, summary, full_text, url, published_at
       FROM company_news
      WHERE scraped_at >= $1 AND symbol = ANY($2)
      ORDER BY symbol ASC, published_at DESC NULLS LAST
      LIMIT 5000`,
    [dayStart, subscribed],
  );
  const bySymbol = new Map<string, NewsRow[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol) ?? [];
    arr.push(r);
    bySymbol.set(r.symbol, arr);
  }
  const targets = [...bySymbol.entries()].filter(([symbol]) => !alreadyDone.has(symbol));
  if (targets.length === 0) {
    return {
      asOfDate,
      subscribed: subscribed.length,
      symbolsWithNews: bySymbol.size,
      symbolsAnalyzed: 0,
      skippedAlreadyDone: alreadyDone.size,
      note: "nothing to analyze (no fresh subscribed news, or all already done)",
    };
  }

  let analyzed = 0;
  const failures: { symbol: string; error: string }[] = [];
  for (const [symbol, items] of targets) {
    const user = `Company: ${symbol}\nDate: ${asOfDate}\nArticle count: ${items.length}\n\nNews items:\n${renderItems(items)}\n\nReturn the JSON object specified by the schema.`;
    try {
      const { parsed } = await chatJson(llm, {
        model,
        system: SYSTEM_PROMPT,
        user,
        schema: NEWS_SCHEMA,
        temperature: 0.2,
        // The catalyst list pushed the digest past a 900-token budget, which
        // truncates mid-JSON and parses as nothing.
        maxTokens: 1600,
      });
      if (!parsed) {
        failures.push({ symbol, error: "LLM returned unparseable output" });
        continue;
      }
      await pool.query(
        `INSERT INTO news_analyses
           (symbol, as_of_date, sentiment, sentiment_score, summary, key_points, options_impact, upcoming_catalysts, article_count, model)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)
         ON CONFLICT (symbol, as_of_date) DO UPDATE SET
           sentiment = EXCLUDED.sentiment,
           sentiment_score = EXCLUDED.sentiment_score,
           summary = EXCLUDED.summary,
           key_points = EXCLUDED.key_points,
           options_impact = EXCLUDED.options_impact,
           upcoming_catalysts = EXCLUDED.upcoming_catalysts,
           article_count = EXCLUDED.article_count,
           model = EXCLUDED.model,
           created_at = now()`,
        [
          symbol,
          asOfDate,
          parsed.sentiment,
          parsed.sentiment_score,
          parsed.summary,
          JSON.stringify(parsed.key_points ?? []),
          parsed.options_impact ?? null,
          JSON.stringify(sanitizeCatalysts(parsed.upcoming_catalysts, asOfDate)),
          items.length,
          model,
        ],
      );
      analyzed++;
    } catch (e) {
      failures.push({ symbol, error: errMsg(e, 200) });
    }
  }

  return {
    asOfDate,
    subscribed: subscribed.length,
    symbolsWithNews: bySymbol.size,
    skippedAlreadyDone: alreadyDone.size,
    symbolsAnalyzed: analyzed,
    failures,
    model,
    elapsedMs: Date.now() - startedAt,
  };
}
