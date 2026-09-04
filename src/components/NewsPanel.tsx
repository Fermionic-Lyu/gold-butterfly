import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CompanyNews, NewsAnalysis } from "../lib/types";

// Read-only view over the news pipeline: the latest per-day AI digest on top,
// raw scraped headlines below. Both are filled by the daily scrape-news and
// analyze-news jobs, so this panel only reads.

interface Props {
  symbol: string;
}

const SENTIMENT_STYLE: Record<NewsAnalysis["sentiment"], string> = {
  bullish: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  bearish: "bg-red-500/15 text-red-300 border-red-500/40",
  neutral: "bg-neutral-700/40 text-neutral-300 border-neutral-600",
  mixed: "bg-amber-500/15 text-amber-300 border-amber-500/40",
};

const SOURCE_LABEL: Record<string, string> = {
  finnhub: "Finnhub",
  yahoo: "Yahoo",
  google_news: "Google News",
  benzinga: "Benzinga",
  alpaca: "Alpaca",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

interface NewsResponse {
  analysis: (Omit<NewsAnalysis, "sentiment_score"> & { sentiment_score: number | string | null }) | null;
  items: CompanyNews[];
}

export default function NewsPanel({ symbol }: Props) {
  const newsQuery = useQuery<NewsResponse>({
    queryKey: ["news", symbol],
    queryFn: () => api.get<NewsResponse>(`/api/news/${symbol}`),
  });

  const raw = newsQuery.data?.analysis ?? null;
  const analysis: NewsAnalysis | null = raw
    ? {
        ...raw,
        as_of_date: String(raw.as_of_date).slice(0, 10),
        sentiment_score: raw.sentiment_score == null ? null : Number(raw.sentiment_score),
        key_points: Array.isArray(raw.key_points) ? raw.key_points : [],
      }
    : null;
  const news = newsQuery.data?.items ?? [];
  const loading = newsQuery.isPending;

  if (loading) {
    return <div className="card p-6 text-sm text-neutral-500">Loading news…</div>;
  }

  if (!analysis && news.length === 0) {
    return (
      <div className="card p-6 text-sm text-neutral-400 space-y-2">
        <div className="font-medium text-neutral-300">No news yet for {symbol}</div>
        <p className="text-neutral-500">
          Headlines are scraped every morning for every tracked symbol, and an AI digest is written
          for symbols in users' watchlists. Once that pipeline has run, both appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {analysis && (
        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-semibold">AI News Digest</h2>
            <div className="flex items-center gap-2">
              <span className={`pill border text-xs font-medium capitalize ${SENTIMENT_STYLE[analysis.sentiment]}`}>
                {analysis.sentiment}
                {analysis.sentiment_score != null && (
                  <span className="ml-1 opacity-70">
                    {analysis.sentiment_score > 0 ? "+" : ""}
                    {analysis.sentiment_score.toFixed(2)}
                  </span>
                )}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                {analysis.as_of_date} · {analysis.article_count} articles
              </span>
            </div>
          </div>

          <p className="text-sm text-neutral-200 leading-relaxed">{analysis.summary}</p>

          {analysis.key_points.length > 0 && (
            <ul className="text-sm text-neutral-300 leading-relaxed list-disc pl-5 space-y-0.5">
              {analysis.key_points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}

          {analysis.options_impact && (
            <div className="rounded-lg bg-gold-400/5 border border-gold-400/20 p-3">
              <div className="text-[10px] uppercase tracking-wider text-gold-300/80 font-semibold mb-1">
                Options impact
              </div>
              <p className="text-sm text-neutral-300 leading-relaxed">{analysis.options_impact}</p>
            </div>
          )}

          {analysis.model && <div className="text-[10px] text-neutral-600">via {analysis.model}</div>}
        </div>
      )}

      <div className="card p-4">
        <h2 className="text-lg font-semibold mb-3">Headlines</h2>
        {news.length === 0 ? (
          <div className="text-sm text-neutral-500">No headlines scraped yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {news.map((n) => (
              <li key={n.id} className="py-2.5">
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-neutral-200 hover:text-gold-200 font-medium leading-snug"
                >
                  {n.headline}
                </a>
                {n.summary && (
                  <p className="text-xs text-neutral-500 mt-1 line-clamp-2 leading-relaxed">{n.summary}</p>
                )}
                <div className="flex items-center gap-2 mt-1 text-[10px] text-neutral-600 uppercase tracking-wider">
                  <span>{SOURCE_LABEL[n.source] ?? n.source}</span>
                  {n.published_at && <span>· {timeAgo(n.published_at)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
