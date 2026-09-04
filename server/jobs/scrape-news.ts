// Daily financial news for every tracked instrument → company_news, then the
// LLM digest job for subscribed symbols.
//
// Sources, all free: Alpaca News (same keys as market data, returns article
// bodies), Yahoo Finance RSS, Google News RSS, and Finnhub when a key is set.

import { XMLParser } from "fast-xml-parser";
import { hasFinnhub } from "../env.ts";
import { pool } from "../db.ts";
import { ALPACA_DATA, alpacaFetch, requireAlpaca } from "./shared/alpaca.ts";
import { FH_BASE, finnhubFetch, withToken } from "./shared/finnhub.ts";
import { allInstruments } from "./shared/universe.ts";
import { errMsg, fetchWithTimeout, mapWithConcurrency } from "./shared/util.ts";
import type { JobArgs, JobContext } from "./types.ts";

const MAX_ARTICLES_PER_SYMBOL = 12;
const MAX_FULLTEXT_FETCHES = 4;
const LOOKBACK_DAYS = 2;
const SYMBOL_CONCURRENCY = 6;
const MAX_BODY_CHARS = 12_000;
const UA = "Mozilla/5.0 (compatible; gold-butterfly news bot)";

interface NewsItem {
  source: string;
  headline: string;
  summary: string | null;
  full_text?: string | null;
  url: string;
  image_url: string | null;
  category: string | null;
  published_at: string | null;
}

// ---------- HTML → text ----------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// Paragraph-based article body: enough signal for an LLM digest without a
// DOM library.
function extractArticleText(html: string): string | null {
  const cleaned = html.replace(
    /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi,
    " ",
  );
  const paragraphs: string[] = [];
  for (const m of cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = htmlToText(m[1]);
    if (text.length >= 40) paragraphs.push(text);
  }
  if (paragraphs.length < 2) return null;
  return paragraphs.join("\n\n").slice(0, MAX_BODY_CHARS);
}

async function fetchFullText(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, redirect: "follow" },
      12_000,
    );
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html/i.test(type)) return null;
    const html = (await res.text()).slice(0, 1_500_000);
    return extractArticleText(html);
  } catch {
    return null;
  }
}

// ---------- sources ----------

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchAlpacaNews(symbol: string): Promise<NewsItem[]> {
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const url = new URL(`${ALPACA_DATA}/v1beta1/news`);
  url.searchParams.set("symbols", symbol);
  url.searchParams.set("start", start);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("include_content", "true");
  const data = await alpacaFetch(url.toString());
  const out: NewsItem[] = [];
  for (const it of (data?.news ?? []) as any[]) {
    const link = String(it?.url ?? "").trim();
    const headline = String(it?.headline ?? "").trim();
    if (!link || !headline) continue;
    const content = typeof it.content === "string" && it.content ? htmlToText(it.content) : "";
    out.push({
      source: String(it.source ?? "alpaca").toLowerCase() || "alpaca",
      headline,
      summary: String(it.summary ?? "").trim() || null,
      full_text: content.length >= 80 ? content.slice(0, MAX_BODY_CHARS) : null,
      url: link,
      image_url: (it.images ?? []).find((i: any) => i?.size === "small")?.url ?? it.images?.[0]?.url ?? null,
      category: null,
      published_at: isoOrNull(it.created_at ?? it.updated_at),
    });
  }
  return out;
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

async function fetchRss(feedUrl: string, source: string): Promise<NewsItem[]> {
  const res = await fetchWithTimeout(feedUrl, { headers: { "User-Agent": UA } }, 15_000);
  if (!res.ok) return [];
  const doc = xml.parse(await res.text());
  const raw = doc?.rss?.channel?.item;
  const items: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: NewsItem[] = [];
  for (const e of items) {
    const link = String(e?.link ?? "").trim();
    const headline = htmlToText(String(e?.title ?? ""));
    if (!link || !headline) continue;
    const desc = e?.description ? htmlToText(String(e.description)) : "";
    out.push({
      source,
      headline,
      summary: desc && desc !== headline ? desc.slice(0, 1000) : null,
      url: link,
      image_url: null,
      category: null,
      published_at: isoOrNull(e?.pubDate ?? e?.updated),
    });
  }
  return out;
}

const fetchYahoo = (symbol: string) =>
  fetchRss(
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
    "yahoo",
  );

const fetchGoogleNews = (symbol: string, name: string) => {
  const q = name ? `"${name}" ${symbol} stock` : `${symbol} stock`;
  return fetchRss(
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
    "google_news",
  );
};

async function fetchFinnhubNews(symbol: string): Promise<NewsItem[]> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const items = await finnhubFetch(
    withToken(`${FH_BASE}/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`),
    1100,
  );
  const out: NewsItem[] = [];
  for (const it of (Array.isArray(items) ? items : []) as any[]) {
    const link = String(it?.url ?? "").trim();
    const headline = String(it?.headline ?? "").trim();
    if (!link || !headline) continue;
    const ts = it.datetime;
    out.push({
      source: "finnhub",
      headline,
      summary: String(it.summary ?? "").trim() || null,
      url: link,
      image_url: String(it.image ?? "").trim() || null,
      category: String(it.category ?? "").trim() || null,
      published_at: typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    });
  }
  return out;
}

// ---------- per-symbol ----------

async function scrapeSymbol(symbol: string, name: string) {
  const settled = await Promise.allSettled([
    fetchAlpacaNews(symbol),
    fetchYahoo(symbol),
    fetchGoogleNews(symbol, name),
    hasFinnhub() ? fetchFinnhubNews(symbol) : Promise.resolve([] as NewsItem[]),
  ]);
  const items = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const sourceErrors = settled.filter((s) => s.status === "rejected").length;

  const byUrl = new Map<string, NewsItem>();
  for (const it of items) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  const ranked = [...byUrl.values()]
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, MAX_ARTICLES_PER_SYMBOL);

  // Google News links are JS redirects and never yield a body.
  const needBody = ranked
    .filter((it) => !it.full_text && !/news\.google\.com/.test(it.url))
    .slice(0, MAX_FULLTEXT_FETCHES);
  await Promise.all(needBody.map(async (it) => (it.full_text = await fetchFullText(it.url))));

  if (ranked.length === 0) return { symbol, found: 0, written: 0, sourceErrors };

  // scraped_at is left alone on conflict so the analyzer's "scraped today"
  // filter keeps meaning first-seen-today.
  const params: unknown[] = [];
  const tuples = ranked.map((it) => {
    params.push(
      symbol, it.source, it.headline, it.summary, it.full_text ?? null,
      it.url, it.image_url, it.category, it.published_at,
    );
    const b = params.length - 9;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
  });
  try {
    await pool.query(
      `INSERT INTO company_news
         (symbol, source, headline, summary, full_text, url, image_url, category, published_at)
       VALUES ${tuples.join(",")}
       ON CONFLICT (symbol, url) DO UPDATE SET
         headline = EXCLUDED.headline,
         summary = COALESCE(EXCLUDED.summary, company_news.summary),
         full_text = COALESCE(EXCLUDED.full_text, company_news.full_text),
         image_url = COALESCE(EXCLUDED.image_url, company_news.image_url),
         published_at = COALESCE(EXCLUDED.published_at, company_news.published_at)`,
      params,
    );
  } catch (e) {
    return { symbol, found: ranked.length, written: 0, sourceErrors, error: errMsg(e, 200) };
  }
  return { symbol, found: ranked.length, written: ranked.length, sourceErrors };
}

export async function scrapeNews(args: JobArgs, ctx: JobContext) {
  requireAlpaca();
  const startedAt = Date.now();
  const targets = await allInstruments();
  const only = Array.isArray(args.symbols) ? new Set(args.symbols.map(String)) : null;
  const selected = only ? targets.filter((t) => only.has(t.symbol)) : targets;

  const results = await mapWithConcurrency(selected, SYMBOL_CONCURRENCY, (t) => scrapeSymbol(t.symbol, t.name ?? ""));
  const written = results.reduce((s, r) => s + r.written, 0);
  const errors = results.filter((r) => r.error).map((r) => ({ symbol: r.symbol, error: r.error }));

  const analysis = args.analyze === false ? { skipped: true } : await ctx.runJob("analyze-news", {});

  return {
    symbols: selected.length,
    articlesWritten: written,
    symbolErrors: errors.length,
    errors: errors.slice(0, 10),
    analysis,
    elapsedMs: Date.now() - startedAt,
  };
}
