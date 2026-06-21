"""InsForge REST + RPC access. Each call uses its own short-lived httpx client
so the helpers are safe to call concurrently from Phase A's thread pool, and
each retries transient failures (429/5xx/transport) with backoff.

Retries matter more on Modal than they did in the edge function: agents now run
in parallel containers, so InsForge sees a wider concurrent read burst. Retry is
safe even for apply_agent_tick — it's lease-gated, so a re-sent apply that did
commit is a no-op skip, and one that didn't commit re-applies cleanly.
"""

from __future__ import annotations

import time

import httpx

DEFAULT_TIMEOUT = 120.0
RPC_TIMEOUT = 600.0
_MAX_ATTEMPTS = 3


def _headers(api_key: str, prefer: str = "return=representation", extra: dict | None = None) -> dict:
    h = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Prefer": prefer,
    }
    if extra:
        h.update(extra)
    return h


def _transient_status(code: int) -> bool:
    return code == 429 or 500 <= code < 600


def _request(method: str, url: str, headers: dict, json_body=None, timeout: float = DEFAULT_TIMEOUT, ok_statuses=(206,)):
    """Send with retry on transient HTTP status / transport errors. Returns the
    final httpx.Response (caller decides what counts as success)."""
    last_exc = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            with httpx.Client(timeout=timeout) as c:
                r = c.request(method, url, headers=headers, json=json_body)
        except httpx.HTTPError as e:
            last_exc = e
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(0.5 * (2 ** attempt))
                continue
            raise
        if _transient_status(r.status_code) and attempt < _MAX_ATTEMPTS - 1:
            time.sleep(0.5 * (2 ** attempt))
            continue
        return r
    raise last_exc  # pragma: no cover


def db_get(env: dict, path: str):
    url = f"{env['base_url']}/api/database/records/{path}"
    r = _request("GET", url, _headers(env["api_key"]))
    if not r.is_success:
        raise RuntimeError(f"db get {path} → {r.status_code}: {r.text[:200]}")
    return r.json()


def db_upsert(env: dict, table: str, rows: list[dict]) -> None:
    url = f"{env['base_url']}/api/database/records/{table}"
    r = _request(
        "POST",
        url,
        _headers(env["api_key"], "return=minimal,resolution=merge-duplicates"),
        json_body=rows,
    )
    if not r.is_success:
        raise RuntimeError(f"db upsert {table} → {r.status_code}: {r.text[:300]}")


def db_rpc(env: dict, fn: str, args: dict):
    url = f"{env['base_url']}/api/database/rpc/{fn}"
    r = _request("POST", url, _headers(env["api_key"]), json_body=args, timeout=RPC_TIMEOUT)
    if not r.is_success:
        raise RuntimeError(f"db rpc {fn} → {r.status_code}: {r.text[:500]}")
    return r.json()


def fetch_chain_quotes_paged(env: dict, symbol: str) -> list[dict]:
    """PostgREST caps responses at max-rows=1000; NDX names routinely have
    1500-3000 chain rows. Page via Range headers until a short page so later
    expirations aren't silently dropped."""
    page_size = 1000
    out: list[dict] = []
    page = 0
    url = (
        f"{env['base_url']}/api/database/records/chain_quotes"
        f"?underlying=eq.{symbol}"
        "&select=occ_symbol,expiration,strike,type,bid,ask,delta,iv"
        "&order=expiration.asc,strike.asc"
    )
    while True:
        frm = page * page_size
        to = frm + page_size - 1
        r = _request(
            "GET",
            url,
            _headers(env["api_key"], extra={"Range": f"{frm}-{to}", "Range-Unit": "items"}),
        )
        if not r.is_success and r.status_code != 206:
            raise RuntimeError(f"db get chain_quotes → {r.status_code}: {r.text[:200]}")
        rows = r.json()
        out.extend(rows)
        if len(rows) < page_size:
            break
        page += 1
        if page > 50:
            break
    return out
