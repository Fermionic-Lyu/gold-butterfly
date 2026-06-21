# Gold Butterfly — daily financial-news scraper, on Modal.
#
# WHY MODAL (and not an InsForge edge function like the rest of the pipeline):
# real multi-source news scraping wants things Deno edge functions don't have
# — long runtime (100 symbols x several sources x per-article body fetch),
# wide parallel fan-out, and the Python scraping stack (trafilatura et al).
# This is the one piece of the pipeline that genuinely earns a second platform.
# Everything else (storage, the LLM digest) stays inside InsForge.
#
# WHAT IT DOES, once a day:
#   1. Reads the DISTINCT union of symbols users have subscribed to (the
#      `subscriptions` table), joined to `instruments` for company names.
#   2. Fans out one container per symbol. Each pulls news from three free
#      sources — Finnhub /company-news, Yahoo Finance RSS, Google News RSS —
#      best-effort fetches each article URL and extracts the body with
#      trafilatura, dedupes by URL, and UPSERTs into `company_news`.
#   3. Pings the `analyze-news` edge function so the LLM digest runs against
#      the rows we just wrote (no cron-timing guesswork between platforms).
#
# DEPLOY (see modal/README.md for the full walk-through):
#   pip install modal && modal setup
#   modal secret create gold-butterfly \
#       INSFORGE_BASE_URL=... INSFORGE_API_KEY=... \
#       FINNHUB_API_KEY=...   SCHEDULE_SECRET=...
#   modal deploy modal/scrape_news.py      # registers the daily cron
#   modal run    modal/scrape_news.py      # one-off manual run to verify

from __future__ import annotations  # lazy annotations so `X | None` works on 3.9

import os
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

import modal

app = modal.App("gold-butterfly-news")

image = modal.Image.debian_slim().pip_install(
    "httpx==0.27.2",
    "trafilatura==1.12.2",
    "feedparser==6.0.11",
)

# One Modal secret holds everything the job needs. INSFORGE_API_KEY must be a
# project/service key (the same kind in .insforge/project.json) — it writes to
# `company_news`, so it has to bypass RLS. SCHEDULE_SECRET matches the InsForge
# platform secret so we can trigger the analyze-news function.
secret = modal.Secret.from_name("gold-butterfly")

# If nobody has subscribed yet, fall back to scraping the tracked instrument
# universe so the demo has data on day one. Flip to False to scrape strictly
# what users subscribed to.
FALLBACK_TO_UNIVERSE = True

# Per-symbol caps that bound runtime and Finnhub usage.
MAX_ARTICLES_PER_SYMBOL = 12          # newest N across all sources get stored
MAX_FULLTEXT_FETCHES = 8              # of those, fetch+extract body for top N
LOOKBACK_DAYS = 2                     # news window: yesterday + today (UTC)
HTTP_TIMEOUT = 15.0


# ── InsForge REST helpers (PostgREST under the hood) ───────────────────────
def _db_headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['INSFORGE_API_KEY']}",
        "Content-Type": "application/json",
    }


def _base_url() -> str:
    return os.environ["INSFORGE_BASE_URL"].rstrip("/")


def db_get(client, path: str):
    r = client.get(f"{_base_url()}/api/database/records/{path}", headers=_db_headers())
    r.raise_for_status()
    return r.json()


def db_upsert(client, table: str, rows: list, on_conflict: str):
    if not rows:
        return 0
    # resolution=merge-duplicates + ?on_conflict makes re-runs idempotent:
    # the same (symbol, url) updates in place instead of erroring.
    headers = {**_db_headers(), "Prefer": "return=minimal,resolution=merge-duplicates"}
    r = client.post(
        f"{_base_url()}/api/database/records/{table}?on_conflict={on_conflict}",
        headers=headers,
        json=rows,
    )
    r.raise_for_status()
    return len(rows)


# ── Source 1: Finnhub /company-news ────────────────────────────────────────
def fetch_finnhub(client, symbol: str) -> list:
    token = os.environ.get("FINNHUB_API_KEY", "")
    if not token:
        return []
    to_d = date.today()
    from_d = to_d - timedelta(days=LOOKBACK_DAYS)
    url = (
        f"https://finnhub.io/api/v1/company-news?symbol={quote_plus(symbol)}"
        f"&from={from_d.isoformat()}&to={to_d.isoformat()}&token={token}"
    )
    try:
        r = client.get(url)
        if r.status_code != 200:
            return []
        items = r.json() or []
    except Exception:
        return []
    out = []
    for it in items:
        link = (it.get("url") or "").strip()
        headline = (it.get("headline") or "").strip()
        if not link or not headline:
            continue
        ts = it.get("datetime")
        published = (
            datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
            if isinstance(ts, (int, float)) and ts > 0
            else None
        )
        out.append(
            {
                "source": "finnhub",
                "headline": headline,
                "summary": (it.get("summary") or "").strip() or None,
                "url": link,
                "image_url": (it.get("image") or "").strip() or None,
                "category": (it.get("category") or "").strip() or None,
                "published_at": published,
            }
        )
    return out


# ── Sources 2 & 3: RSS feeds (Yahoo Finance, Google News) ──────────────────
def _parse_rss(client, feed_url: str, source: str) -> list:
    import feedparser

    try:
        r = client.get(feed_url, headers={"User-Agent": "Mozilla/5.0 (gold-butterfly news bot)"})
        if r.status_code != 200:
            return []
        parsed = feedparser.parse(r.content)
    except Exception:
        return []
    out = []
    for e in parsed.entries:
        link = (getattr(e, "link", "") or "").strip()
        headline = (getattr(e, "title", "") or "").strip()
        if not link or not headline:
            continue
        published = None
        raw_date = getattr(e, "published", None) or getattr(e, "updated", None)
        if raw_date:
            try:
                published = parsedate_to_datetime(raw_date).astimezone(timezone.utc).isoformat()
            except Exception:
                published = None
        out.append(
            {
                "source": source,
                "headline": headline,
                "summary": (getattr(e, "summary", "") or "").strip() or None,
                "url": link,
                "image_url": None,
                "category": None,
                "published_at": published,
            }
        )
    return out


def fetch_yahoo(client, symbol: str) -> list:
    url = (
        f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={quote_plus(symbol)}"
        "&region=US&lang=en-US"
    )
    return _parse_rss(client, url, "yahoo")


def fetch_google_news(client, symbol: str, name: str) -> list:
    # Quote the company name and pin the ticker to cut cross-company noise.
    query = f'"{name}" {symbol} stock' if name else f"{symbol} stock"
    url = (
        f"https://news.google.com/rss/search?q={quote_plus(query)}"
        "&hl=en-US&gl=US&ceid=US:en"
    )
    return _parse_rss(client, url, "google_news")


# ── Article body extraction ────────────────────────────────────────────────
def extract_fulltext(client, url: str) -> str | None:
    import trafilatura

    try:
        r = client.get(url, headers={"User-Agent": "Mozilla/5.0 (gold-butterfly news bot)"})
        if r.status_code != 200 or not r.text:
            return None
        text = trafilatura.extract(r.text, include_comments=False, include_tables=False)
        if not text:
            return None
        return text.strip()[:12000]  # cap stored body so rows stay sane
    except Exception:
        return None


def _recency_key(item: dict) -> str:
    # Sort newest-first; items with no date sink to the bottom.
    return item.get("published_at") or ""


# ── Per-symbol worker (one container each, fanned out by .map) ──────────────
@app.function(image=image, secrets=[secret], timeout=600, max_containers=8)
def scrape_symbol(arg: tuple) -> dict:
    import httpx

    symbol, name = arg
    with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        items = (
            fetch_finnhub(client, symbol)
            + fetch_yahoo(client, symbol)
            + fetch_google_news(client, symbol, name)
        )

        # Dedupe by URL (same story surfaces on multiple feeds), newest first.
        by_url: dict[str, dict] = {}
        for it in items:
            by_url.setdefault(it["url"], it)
        ranked = sorted(by_url.values(), key=_recency_key, reverse=True)[:MAX_ARTICLES_PER_SYMBOL]

        # Extract bodies only for the freshest handful (bounds runtime/egress).
        for it in ranked[:MAX_FULLTEXT_FETCHES]:
            it["full_text"] = extract_fulltext(client, it["url"])

        rows = [{"symbol": symbol, **it, "full_text": it.get("full_text")} for it in ranked]
        try:
            written = db_upsert(client, "company_news", rows, on_conflict="symbol,url")
        except Exception as e:
            return {"symbol": symbol, "found": len(rows), "written": 0, "error": str(e)[:200]}

    return {"symbol": symbol, "found": len(rows), "written": written}


# ── Orchestrator: daily cron entrypoint ────────────────────────────────────
def _targets(client) -> list[tuple]:
    """Distinct subscribed symbols, joined to instrument names."""
    names = {
        row["symbol"]: (row.get("name") or "")
        for row in db_get(client, "instruments?select=symbol,name&limit=1000")
    }
    subs = db_get(client, "subscriptions?select=symbol&limit=5000")
    symbols = sorted({s["symbol"] for s in subs if s.get("symbol")})
    if not symbols and FALLBACK_TO_UNIVERSE:
        symbols = sorted(names.keys())
    return [(s, names.get(s, "")) for s in symbols]


def _trigger_analysis(client) -> dict:
    secret_val = os.environ.get("SCHEDULE_SECRET", "")
    if not secret_val:
        return {"triggered": False, "reason": "no SCHEDULE_SECRET"}
    try:
        r = client.post(
            f"{_base_url()}/functions/analyze-news",
            headers={"Content-Type": "application/json", "X-Schedule-Secret": secret_val},
            json={},
        )
        return {"triggered": True, "status": r.status_code, "body": r.text[:300]}
    except Exception as e:
        return {"triggered": False, "error": str(e)[:200]}


@app.function(image=image, secrets=[secret], timeout=3600, schedule=modal.Cron("30 8 * * *"))
def daily():
    """Runs ~08:30 UTC daily. Scrapes every subscribed symbol, then kicks off
    the in-stack LLM analysis pass."""
    import httpx

    started = time.time()
    with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        targets = _targets(client)
    print(f"scraping {len(targets)} symbols")
    if not targets:
        return {"symbols": 0, "note": "no subscribed symbols"}

    results = list(scrape_symbol.map(targets))
    total_written = sum(r.get("written", 0) for r in results)
    errors = [r for r in results if r.get("error")]

    # analyze-news runs LLM calls sequentially per symbol, so the synchronous
    # response can take a few minutes. Wait generously; the 09:30 UTC backstop
    # cron re-runs analysis idempotently if this still times out.
    with httpx.Client(timeout=300.0, follow_redirects=True) as client:
        analysis = _trigger_analysis(client)

    summary = {
        "symbols": len(targets),
        "articles_written": total_written,
        "symbol_errors": len(errors),
        "analysis_trigger": analysis,
        "elapsed_s": round(time.time() - started, 1),
    }
    print(summary)
    return summary


# `modal run modal/scrape_news.py` invokes this for a manual one-off.
@app.local_entrypoint()
def main():
    print(daily.remote())
