# Trading-agent runner on Modal — replaces the trading-tick edge function.
#
# WHY MODAL: the edge function ran agents strictly sequentially
# (BATCH_CONCURRENCY=1) because a Deno edge function can't safely parallelize
# 3 agents x N symbols x an LLM call each inside its execution/HTTP window.
# Modal fans the agents out across containers (run_agent.map) and each agent
# fans its symbols out across a thread pool — no shared wall-clock budget.
#
# WHAT STAYS IN POSTGRES (unchanged): apply_agent_tick (atomic, lease-gated for
# exactly-once per agent/day), the decisions unique index, and agent_runs. This
# worker only computes the payload and calls the RPC, exactly like the edge
# function did — so cutover is safe and the lease makes overlap harmless.
#
# DEPLOY (see modal/TRADING.md):
#   modal deploy modal/trading_app.py        # registers the daily crons
#   modal run    modal/trading_app.py --dry-run --force   # compute, don't apply
#
# Schedules: primary 22:10 UTC + backstop 22:50 UTC, Mon-Fri (after the close
# in both EDT and EST, matching the old InsForge cron rows).

from __future__ import annotations

import os

import modal

# Only import-safe modules at the top level — `modal deploy` imports this file
# in the local venv, which has `modal` + stdlib but NOT httpx/openai (those live
# in the image). `coordinator`/`util` are stdlib-only; `db`/`agent` (httpx,
# openai) are imported INSIDE the functions, where the image is present.
from trading import coordinator
from trading.util import et_today_date, now_utc

app = modal.App("gold-butterfly-agents")

image = (
    modal.Image.debian_slim()
    .pip_install("httpx==0.27.2", "openai>=1.40,<2")
    .add_local_python_source("trading")
)

# Reuse the same Modal secret as the news scraper, extended with the
# trading-specific keys (ALPACA_API_KEY/SECRET, OPENROUTER_API_KEY).
secret = modal.Secret.from_name("gold-butterfly")


def _env() -> dict:
    return {
        "base_url": os.environ["INSFORGE_BASE_URL"].rstrip("/"),
        "api_key": os.environ["INSFORGE_API_KEY"],
        "alpaca_key": os.environ.get("ALPACA_API_KEY", ""),
        "alpaca_secret": os.environ.get("ALPACA_API_SECRET", ""),
        "openrouter_key": os.environ.get("OPENROUTER_API_KEY", ""),
    }


@app.function(image=image, secrets=[secret], timeout=1200, max_containers=16)
def run_agent(agent: dict, run_date: str, dry_run: bool = False) -> dict:
    """One agent, one container. Wraps process_agent with agent_runs status
    tracking (skipped on dry runs)."""
    from trading import db  # deferred: pulls httpx (image-only)
    from trading.agent import process_agent  # deferred: pulls openai (image-only)

    env = _env()
    started_at = now_utc().isoformat()
    if not dry_run:
        try:
            db.db_upsert(env, "agent_runs", [{"run_date": run_date, "agent_slug": agent["slug"], "status": "running", "started_at": started_at}])
        except Exception:
            pass
    try:
        result = process_agent(agent, env, run_date, dry_run=dry_run)
        if not dry_run:
            try:
                db.db_upsert(env, "agent_runs", [{"run_date": run_date, "agent_slug": agent["slug"], "status": "done", "started_at": started_at, "finished_at": now_utc().isoformat(), "error": None}])
            except Exception:
                pass
        return {"slug": agent["slug"], "ok": True, "result": result}
    except Exception as e:  # noqa: BLE001
        err = str(e)[:500]
        if not dry_run:
            try:
                db.db_upsert(env, "agent_runs", [{"run_date": run_date, "agent_slug": agent["slug"], "status": "error", "started_at": started_at, "finished_at": now_utc().isoformat(), "error": err}])
            except Exception:
                pass
        return {"slug": agent["slug"], "ok": False, "error": err}


def _coordinate(force: bool = False, only_slug: str | None = None, run_date: str | None = None, dry_run: bool = False) -> dict:
    """Orchestrator — runs inside whichever function calls it, fans agents out
    via run_agent.map. Idempotent: re-runs skip done/in-flight agents, and the
    apply_agent_tick lease makes any overlap a no-op."""
    from trading import db  # deferred: pulls httpx (image-only)

    env = _env()
    run_date = run_date or et_today_date()

    # ---- single-slug debug mode ----
    if only_slug:
        agents = db.db_get(env, f"agents?slug=eq.{only_slug}&active=eq.true&limit=1")
        if not agents:
            return {"error": f"no active agent with slug {only_slug}", "runDate": run_date}
        res = run_agent.remote(agents[0], run_date, dry_run)
        return {"tickedAt": now_utc().isoformat(), "runDate": run_date, "mode": "single", "dryRun": dry_run, "result": res}

    # ---- trading-day gate ----
    if not force:
        holidays = []
        try:
            holidays = db.db_get(env, f"market_holidays?date=eq.{run_date}&select=early_close_et&limit=1")
        except Exception:
            holidays = []
        reason = coordinator.trading_day_skip_reason(run_date, holidays)
        if reason:
            return {"skipped": True, "reason": reason, "runDate": run_date}

    all_agents = db.db_get(env, "agents?active=eq.true&select=*&limit=500")
    if not all_agents:
        return {"skipped": True, "reason": "no active agents", "runDate": run_date}

    today_runs = db.db_get(env, f"agent_runs?run_date=eq.{run_date}&select=agent_slug,status,dispatched_at,started_at&limit=1000")
    now_ms = now_utc().timestamp() * 1000
    to_process, skipped = coordinator.select_agents_to_process(all_agents, today_runs, now_ms)
    if not to_process:
        return {"skipped": True, "reason": "all agents already done/in-flight for today", "runDate": run_date, "totalAgents": len(all_agents)}

    # Pre-create 'pending' rows so dashboards see in-flight runs immediately.
    if not dry_run:
        dispatched_at = now_utc().isoformat()
        try:
            db.db_upsert(env, "agent_runs", [{"run_date": run_date, "agent_slug": a["slug"], "status": "pending", "dispatched_at": dispatched_at} for a in to_process])
        except Exception:
            pass

    # Fan out — one container per agent, all in parallel.
    results = list(
        run_agent.map(to_process, kwargs={"run_date": run_date, "dry_run": dry_run}, return_exceptions=True)
    )
    clean = []
    for a, r in zip(to_process, results):
        if isinstance(r, Exception):
            clean.append({"slug": a["slug"], "ok": False, "error": str(r)[:500]})
        else:
            clean.append(r)

    succeeded = sum(1 for r in clean if r.get("ok"))
    return {
        "tickedAt": now_utc().isoformat(),
        "runDate": run_date,
        "mode": "batch",
        "dryRun": dry_run,
        "totalAgents": len(all_agents),
        "skipped": skipped,
        "dispatched": len(to_process),
        "succeeded": succeeded,
        "failed": len(clean) - succeeded,
        "results": clean,
    }


# Primary daily tick — 22:10 UTC, Mon-Fri (after the close in both EDT and EST).
@app.function(image=image, secrets=[secret], timeout=3600, schedule=modal.Cron("10 22 * * 1-5"))
def tick_primary() -> dict:
    return _coordinate()


# Retry backstop — 22:50 UTC. Idempotent; only picks up agents the primary missed.
@app.function(image=image, secrets=[secret], timeout=3600, schedule=modal.Cron("50 22 * * 1-5"))
def tick_backstop() -> dict:
    return _coordinate()


# Manual trigger (invoked remotely by the local entrypoint).
@app.function(image=image, secrets=[secret], timeout=3600)
def tick(force: bool = False, only_slug: str = "", run_date: str = "", dry_run: bool = False) -> dict:
    return _coordinate(force=force, only_slug=only_slug or None, run_date=run_date or None, dry_run=dry_run)


@app.local_entrypoint()
def main(dry_run: bool = False, force: bool = False, only_slug: str = "", run_date: str = ""):
    import json

    out = tick.remote(force=force, only_slug=only_slug, run_date=run_date, dry_run=dry_run)
    # Compact view: drop the verbose payload/snapshots, keep the per-agent
    # action blobs (symbol → open/close/hold/skip_*) for eyeballing.
    summary = {k: v for k, v in out.items() if k != "results"}
    agents = []
    for r in out.get("results", []):
        row = {"slug": r.get("slug"), "ok": r.get("ok")}
        if r.get("error"):
            row["error"] = r["error"]
        res = r.get("result") or {}
        for k in ("cash", "positions_mtm", "total_equity", "open_positions"):
            if k in res:
                row[k] = res[k]
        row["actions"] = res.get("actions")
        agents.append(row)
    summary["agents"] = agents
    print(json.dumps(summary, indent=2, default=str))
