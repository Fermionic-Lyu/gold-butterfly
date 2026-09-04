// One LLM digest per (subscribed symbol, day) over the articles scraped today.
//   args: { date?: "YYYY-MM-DD", model?: string, force?: boolean }

import { pool, query } from "../db.ts";
import { chatJson, openrouterClient } from "./shared/llm.ts";
import { errMsg } from "./shared/util.ts";
import type { JobArgs } from "./types.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

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
    },
    required: ["sentiment", "sentiment_score", "summary", "key_points", "options_impact"],
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
        maxTokens: 900,
      });
      if (!parsed) {
        failures.push({ symbol, error: "LLM returned unparseable output" });
        continue;
      }
      await pool.query(
        `INSERT INTO news_analyses
           (symbol, as_of_date, sentiment, sentiment_score, summary, key_points, options_impact, article_count, model)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT (symbol, as_of_date) DO UPDATE SET
           sentiment = EXCLUDED.sentiment,
           sentiment_score = EXCLUDED.sentiment_score,
           summary = EXCLUDED.summary,
           key_points = EXCLUDED.key_points,
           options_impact = EXCLUDED.options_impact,
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
