"""Pure coordinator logic: the trading-day gate and the idempotent agent-
selection rules. No I/O here — the Modal app fetches agents/agent_runs and
passes them in, so this stays trivially testable."""

from __future__ import annotations

from datetime import date, datetime

# 'pending'/'running' agent_runs rows older than this are treated as dead
# dispatches and retried by the next tick.
STALE_MS = 15 * 60 * 1000


def _parse_ms(ts) -> float:
    if not ts:
        return 0.0
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, TypeError):
        return 0.0


def trading_day_skip_reason(run_date: str, holiday_rows: list[dict]):
    """None → trade today. Otherwise a human reason string."""
    try:
        d = date.fromisoformat(run_date)
    except ValueError:
        return None
    if d.weekday() >= 5:  # Sat=5, Sun=6
        return "weekend"
    # A holiday row with early_close_et IS NULL is a full closure; rows with a
    # time set are half-days where agents still run post-close.
    if holiday_rows and holiday_rows[0].get("early_close_et") is None:
        return "holiday — full closure"
    return None


def select_agents_to_process(all_agents: list[dict], today_runs: list[dict], now_ms: float):
    """Skip agents already done, or in-flight within the staleness window;
    retry stale pending/running and errors. Mirrors the edge-function gate."""
    skip = set()
    for r in today_runs:
        status = r.get("status")
        slug = r.get("agent_slug")
        if status == "done":
            skip.add(slug)
        elif status == "running":
            if now_ms - _parse_ms(r.get("started_at")) < STALE_MS:
                skip.add(slug)
        elif status == "pending":
            if now_ms - _parse_ms(r.get("dispatched_at")) < STALE_MS:
                skip.add(slug)
    to_process = [a for a in all_agents if a["slug"] not in skip]
    return to_process, len(all_agents) - len(to_process)
