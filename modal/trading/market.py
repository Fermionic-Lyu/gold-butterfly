"""Market data: live Alpaca (spot, option chain, HV30) plus the cached-chain
path that reads chain_quotes/chain_underlyings filled by the fetch-chains cron.

The after-close tick normally uses the DB cache; live Alpaca is the fallback
for non-NDX names or when the scheduler skipped a chain refresh."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import httpx

from .db import fetch_chain_quotes_paged
from .pricing import hv30_from_closes
from .util import parse_occ, to_num

ALPACA_DATA = "https://data.alpaca.markets"
CHAIN_FRESHNESS_SECONDS = 10 * 60


def alpaca_fetch(env: dict, url: str, attempt: int = 0):
    with httpx.Client(timeout=30.0) as c:
        r = c.get(
            url,
            headers={
                "APCA-API-KEY-ID": env["alpaca_key"],
                "APCA-API-SECRET-KEY": env["alpaca_secret"],
                "Accept": "application/json",
            },
        )
    transient = r.status_code == 429 or 500 <= r.status_code < 600
    if transient and attempt < 3:
        time.sleep(0.6 * (2 ** attempt))
        return alpaca_fetch(env, url, attempt + 1)
    if not r.is_success:
        raise RuntimeError(f"Alpaca {r.status_code}: {r.text[:300]}")
    return r.json()


def fetch_spot(env: dict, symbol: str):
    try:
        t = alpaca_fetch(env, f"{ALPACA_DATA}/v2/stocks/{symbol}/trades/latest?feed=iex")
        p = t.get("trade", {}).get("p")
        if isinstance(p, (int, float)):
            return p
    except Exception:
        pass
    try:
        q = alpaca_fetch(env, f"{ALPACA_DATA}/v2/stocks/{symbol}/quotes/latest?feed=iex")
        bp, ap = q.get("quote", {}).get("bp"), q.get("quote", {}).get("ap")
        if isinstance(bp, (int, float)) and isinstance(ap, (int, float)):
            return (bp + ap) / 2
    except Exception:
        pass
    return None


def fetch_chain(env: dict, symbol: str, spot: float) -> list[dict]:
    horizon = (datetime.now(timezone.utc) + timedelta(days=90)).date().isoformat()
    band = spot * 0.4
    base = httpx.URL(f"{ALPACA_DATA}/v1beta1/options/snapshots/{symbol}")
    params = {
        "limit": "1000",
        "strike_price_gte": f"{max(0.0, spot - band):.2f}",
        "strike_price_lte": f"{spot + band:.2f}",
        "expiration_date_lte": horizon,
    }
    all_snaps: dict = {}
    page_token = None
    pages = 0
    while True:
        p = dict(params)
        if page_token:
            p["page_token"] = page_token
        data = alpaca_fetch(env, str(base.copy_merge_params(p)))
        if data.get("snapshots"):
            all_snaps.update(data["snapshots"])
        page_token = data.get("next_page_token")
        pages += 1
        if not page_token or pages >= 8:
            break

    contracts: list[dict] = []
    for occ, snap in all_snaps.items():
        parsed = parse_occ(occ)
        if not parsed:
            continue
        q = (snap or {}).get("latestQuote") or {}
        contracts.append(
            {
                "symbol": occ,
                "expiration": parsed["expiration"],
                "strike": parsed["strike"],
                "type": parsed["type"],
                "bid": q.get("bp"),
                "ask": q.get("ap"),
                "delta": (snap.get("greeks") or {}).get("delta"),
                "iv": snap.get("impliedVolatility"),
            }
        )
    return contracts


def fetch_hv30(env: dict, symbol: str):
    end = datetime.now(timezone.utc).date().isoformat()
    start = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()
    url = (
        f"{ALPACA_DATA}/v2/stocks/{symbol}/bars?timeframe=1Day"
        f"&start={start}&end={end}&limit=60&adjustment=split&feed=iex"
    )
    try:
        data = alpaca_fetch(env, url)
        closes = [b["c"] for b in (data.get("bars") or []) if isinstance(b.get("c"), (int, float))]
        return hv30_from_closes(closes)
    except Exception:
        return None


def _parse_ts(ts: str):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def fetch_chain_from_cache(env: dict, symbol: str):
    """Read a fresh chain from the DB cache. Returns None if missing or older
    than 10 min so the caller can fall back to live Alpaca."""
    try:
        from .db import db_get

        underlyings = db_get(
            env, f"chain_underlyings?symbol=eq.{symbol}&select=spot,fetched_at&limit=1"
        )
        if not underlyings:
            return None
        u = underlyings[0]
        fetched = _parse_ts(u.get("fetched_at"))
        if fetched is None:
            return None
        age = (datetime.now(timezone.utc) - fetched).total_seconds()
        if age > CHAIN_FRESHNESS_SECONDS:
            return None
        quotes = fetch_chain_quotes_paged(env, symbol)
        contracts = [
            {
                "symbol": q["occ_symbol"],
                # chain_quotes.expiration is a DATE; PostgREST renders it as
                # "...T00:00:00.000Z" — slice to plain YYYY-MM-DD to match the
                # live-fetch path.
                "expiration": str(q["expiration"])[:10],
                "strike": to_num(q.get("strike")),
                "type": q["type"],
                "bid": to_num(q.get("bid")),
                "ask": to_num(q.get("ask")),
                "delta": to_num(q.get("delta")),
                "iv": to_num(q.get("iv")),
            }
            for q in quotes
        ]
        return {
            "spot": to_num(u.get("spot")),
            "contracts": contracts,
            "fetched_at": u.get("fetched_at"),
        }
    except Exception:
        return None
