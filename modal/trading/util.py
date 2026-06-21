"""Small shared helpers: numeric coercion, time/date math, OCC parsing."""

from __future__ import annotations

import re
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - py<3.9 fallback, unused on Modal
    ZoneInfo = None  # type: ignore

_ET = ZoneInfo("America/New_York") if ZoneInfo else timezone.utc
_OCC_RE = re.compile(r"^[A-Z]+(\d{6})([CP])(\d{8})$")


def to_num(x, default=None):
    """PostgREST renders NUMERIC as JSON number or string depending on size;
    coerce defensively (mirrors the `Number(...)` calls in the TS original)."""
    if x is None or x == "":
        return default
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def et_today_date(now: datetime | None = None) -> str:
    """Today's calendar date in US/Eastern (DST-aware). Used as the run_date
    key shared by agent_runs / decisions across one tick."""
    now = now or now_utc()
    return now.astimezone(_ET).date().isoformat()


def _date_at(exp: str, hour: int) -> datetime | None:
    try:
        return datetime.fromisoformat(str(exp)[:10]).replace(
            tzinfo=timezone.utc, hour=hour, minute=0, second=0, microsecond=0
        )
    except (ValueError, TypeError):
        return None


def days_to_expiration(exp: str, now: datetime | None = None) -> float:
    """DTE measured to 16:00 UTC on the expiration date, floored at 0 (matches
    the `T16:00:00Z` convention in the TS original)."""
    now = now or now_utc()
    d = _date_at(exp, 16)
    if d is None:
        return 0.0
    return max((d - now).total_seconds() / 86400.0, 0.0)


def expiration_passed(exp: str, now: datetime | None = None) -> bool:
    """True once we're past 20:00 UTC (~the close) on the expiration date —
    the boundary the TS MTM logic uses to mark a leg expired."""
    now = now or now_utc()
    d = _date_at(exp, 20)
    return d is not None and d < now


def parse_occ(occ: str):
    """OCC option symbol → {expiration, type, strike} (or None)."""
    m = _OCC_RE.match(occ or "")
    if not m:
        return None
    ymd = m.group(1)
    return {
        "expiration": f"20{ymd[0:2]}-{ymd[2:4]}-{ymd[4:6]}",
        "type": "call" if m.group(2) == "C" else "put",
        "strike": int(m.group(3)) / 1000.0,
    }
