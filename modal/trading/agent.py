"""Per-agent worker: Phase A (analyze each watched symbol, in parallel) and
Phase B (deterministic MTM/closes, then ranked greedy commit of opens), ending
in a single atomic apply_agent_tick call.

A faithful port of processAgent/analyzeSymbol from functions/trading-tick.ts;
the one structural change is that Phase A fans out over symbols with a thread
pool (the edge function did too) and the *caller* fans out agents across Modal
containers — eliminating the BATCH_CONCURRENCY=1 serialization.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from openai import OpenAI

from . import db, market
from .decision import DAILY_CADENCE_ADDENDUM, DECISION_SCHEMA, build_user_prompt, extract_json
from .pricing import mark_to_market_position, mid_of
from .snapshot import build_symbol_snapshot
from .util import expiration_passed, to_num
from .validation import pre_validate_open

_TRANSIENT = ("timeout", "econnreset", "socket hang up", "connection reset")


def _normalize_position(p: dict) -> dict:
    p = dict(p)
    p["entry_cost"] = to_num(p.get("entry_cost"), 0.0)
    cv = to_num(p.get("current_value"))
    p["current_value"] = cv
    p["reserved_collateral"] = to_num(p.get("reserved_collateral"), 0.0)
    legs = []
    for l in p.get("legs") or []:
        l = dict(l)
        l["sign"] = int(to_num(l.get("sign"), 0))
        l["qty"] = to_num(l.get("qty"), 0)
        if l.get("strike") is not None:
            l["strike"] = to_num(l.get("strike"))
        l["fill_price"] = to_num(l.get("fill_price"), 0.0)
        if l.get("current_price") is not None:
            l["current_price"] = to_num(l.get("current_price"))
        legs.append(l)
    p["legs"] = legs
    return p


def analyze_symbol(symbol: str, agent: dict, all_open: list[dict], env: dict, llm_client: OpenAI) -> dict:
    try:
        recent_closed = db.db_get(
            env,
            f"positions?agent_id=eq.{agent['id']}&symbol=eq.{symbol}"
            "&status=in.(closed,expired)&order=closed_at.desc&limit=5"
            "&select=strategy,opened_at,closed_at,realized_pnl,entry_cost",
        )
        cutoff = (datetime.now(timezone.utc) - timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ")
        iv_snaps_raw = db.db_get(
            env, f"iv_snapshots?symbol=eq.{symbol}&captured_at=gte.{cutoff}&select=atm_iv&limit=5000"
        )

        spot = None
        contracts: list[dict] = []
        hv30 = None
        cached = market.fetch_chain_from_cache(env, symbol)
        if cached and cached["spot"] is not None:
            spot = cached["spot"]
            contracts = cached["contracts"]
            try:
                inst = db.db_get(env, f"instruments?symbol=eq.{symbol}&select=hv30&limit=1")
                hv30 = to_num(inst[0]["hv30"]) if inst else None
            except Exception:
                hv30 = None
        else:
            spot = market.fetch_spot(env, symbol)
            if spot is None:
                return {"kind": "error", "symbol": symbol, "error": "no spot"}
            contracts = market.fetch_chain(env, symbol, spot)
            hv30 = market.fetch_hv30(env, symbol)

        this_sym_open_raw = [p for p in all_open if p["symbol"] == symbol]
        mtm_results = [
            {"pos": pos, "result": mark_to_market_position(pos, spot, contracts)}
            for pos in this_sym_open_raw
        ]
        this_sym_open = [
            {
                **m["pos"],
                "current_value": m["result"]["current_value"]
                if m["result"]["current_value"] is not None
                else m["pos"].get("current_value"),
                "legs": m["result"]["legs"],
            }
            for m in mtm_results
        ]

        market_snapshot = build_symbol_snapshot(symbol, spot, contracts, hv30)

        iv_rank_info = None
        if isinstance(iv_snaps_raw, list) and market_snapshot["atmIV"] is not None:
            ivs = [v for v in (to_num(s.get("atm_iv")) for s in iv_snaps_raw) if v is not None]
            if len(ivs) >= 5:
                lo, hi = min(ivs), max(ivs)
                rank = (market_snapshot["atmIV"] - lo) / (hi - lo) if hi > lo else None
                iv_rank_info = {"rank": rank, "samples": len(ivs), "min": lo, "max": hi}
            elif ivs:
                iv_rank_info = {"rank": None, "samples": len(ivs), "min": None, "max": None}

        other_open = [p for p in all_open if p["symbol"] != symbol]
        equity_from_positions = sum(
            (p.get("current_value") if p.get("current_value") is not None else p.get("entry_cost") or 0)
            for p in this_sym_open
        ) + sum(
            (p.get("current_value") if p.get("current_value") is not None else p.get("entry_cost") or 0)
            for p in other_open
        )
        total_equity = agent["cash"] + equity_from_positions

        user_prompt = build_user_prompt(
            symbol=symbol,
            preset=agent["preset"],
            starting_capital=agent["starting_capital"],
            cash=agent["cash"],
            total_equity=total_equity,
            open_count=len(all_open),
            this_symbol_open=this_sym_open,
            recent_closed=recent_closed,
            market_snapshot=market_snapshot,
            iv_rank=iv_rank_info,
        )
        system_content = f"{DAILY_CADENCE_ADDENDUM}\n{agent['system_prompt']}"

        decision = None
        raw_text = ""
        for attempt in range(2):
            try:
                resp = llm_client.chat.completions.create(
                    model=agent["model"],
                    messages=[
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.3,
                    max_tokens=4048,
                    response_format={"type": "json_schema", "json_schema": DECISION_SCHEMA},
                )
            except Exception as e:  # noqa: BLE001
                msg = str(e).lower()
                transient = any(t in msg for t in _TRANSIENT) or _has_5xx(msg)
                if attempt == 0 and transient:
                    continue
                raise
            raw_text = (resp.choices[0].message.content or "") if resp.choices else ""
            try:
                decision = json.loads(raw_text)
            except json.JSONDecodeError:
                decision = extract_json(raw_text)
            if decision is not None:
                break

        return {
            "kind": "ok",
            "symbol": symbol,
            "spot": spot,
            "contracts": contracts,
            "this_sym_open": this_sym_open,
            "mtm_results": mtm_results,
            "market_snapshot": market_snapshot,
            "iv_rank_info": iv_rank_info,
            "recent_closed": recent_closed,
            "decision": decision,
            "raw_text": raw_text,
        }
    except Exception as e:  # noqa: BLE001
        return {"kind": "error", "symbol": symbol, "error": str(e)}


def _has_5xx(msg: str) -> bool:
    import re

    return bool(re.search(r"\b5\d\d\b", msg))


def process_agent(agent: dict, env: dict, run_date: str, dry_run: bool = False) -> dict:
    if not env.get("openrouter_key"):
        raise RuntimeError("OPENROUTER_API_KEY not configured")
    # Coerce the agent's NUMERIC columns once (PostgREST may hand them back as
    # strings); downstream math assumes floats.
    agent = {**agent, "cash": to_num(agent["cash"], 0.0), "starting_capital": to_num(agent["starting_capital"], 0.0)}
    llm_client = OpenAI(
        base_url="https://openrouter.ai/api/v1", api_key=env["openrouter_key"], timeout=600.0
    )

    all_open = [
        _normalize_position(p)
        for p in db.db_get(
            env,
            f"positions?agent_id=eq.{agent['id']}&status=eq.open&order=opened_at.asc&limit=200",
        )
    ]
    symbols = agent["watched_symbols"]

    # Phase A — analyze every watched symbol in parallel (each sees the same
    # starting state; ranking happens in Phase B so analysis order can't bias).
    with ThreadPoolExecutor(max_workers=max(1, len(symbols))) as ex:
        phase_a = list(ex.map(lambda s: analyze_symbol(s, agent, all_open, env, llm_client), symbols))

    cash = float(agent["cash"])
    symbol_blobs: list[dict] = []
    expires, mtm_updates, closes, opens, decisions = [], [], [], [], []

    final_open: dict[str, dict] = {
        p["id"]: {"entry_cost": p["entry_cost"], "current_value": p["current_value"] if p["current_value"] is not None else p["entry_cost"]}
        for p in all_open
    }
    symbol_open_cost: dict[str, float] = {}
    for p in all_open:
        symbol_open_cost[p["symbol"]] = symbol_open_cost.get(p["symbol"], 0.0) + p["entry_cost"]

    open_candidates: list[dict] = []

    for r in phase_a:
        if r["kind"] == "error":
            decisions.append(_decision_row(r["symbol"], "error", None, r["error"][:500], None, None, None, None))
            symbol_blobs.append({"symbol": r["symbol"], "error": r["error"][:200]})
            continue

        # Deterministic MTM / expirations.
        for m in r["mtm_results"]:
            pos, result = m["pos"], m["result"]
            all_expired = bool(pos["legs"]) and all(
                l.get("expiration") and expiration_passed(l["expiration"]) for l in pos["legs"]
            )
            if all_expired and result["current_value"] is not None:
                cv = result["current_value"]
                expires.append(
                    {
                        "position_id": pos["id"],
                        "exit_proceeds": cv,
                        "realized_pnl": cv - pos["entry_cost"],
                        "current_value": cv,
                        "legs": result["legs"],
                    }
                )
                cash += cv
                final_open.pop(pos["id"], None)
                symbol_open_cost[pos["symbol"]] = symbol_open_cost.get(pos["symbol"], 0.0) - pos["entry_cost"]
            elif result["current_value"] is not None:
                mtm_updates.append(
                    {"position_id": pos["id"], "current_value": result["current_value"], "legs": result["legs"]}
                )
                if pos["id"] in final_open:
                    final_open[pos["id"]]["current_value"] = result["current_value"]

        remaining_open = [p for p in r["this_sym_open"] if p["id"] in final_open]
        decision = r["decision"]
        snap = r["market_snapshot"]

        if not decision:
            decisions.append(_decision_row(r["symbol"], "error", None, "Failed to parse JSON from model.", None, snap, {"raw": r["raw_text"]}, None))
            symbol_blobs.append({"symbol": r["symbol"], "action": "error"})
            continue

        action = str(decision.get("action") or "hold")
        confidence = decision.get("confidence")
        if not isinstance(confidence, (int, float)):
            confidence = None
        reasoning = str(decision.get("reasoning") or "")[:1000]

        if action == "hold":
            decisions.append(_decision_row(r["symbol"], "hold", confidence, reasoning, None, snap, decision, None))
            symbol_blobs.append({"symbol": r["symbol"], "action": "hold"})
            continue

        if action == "close":
            position_id = decision.get("close_position_id")
            target = next((p for p in remaining_open if p["id"] == position_id), None)
            if not target:
                decisions.append(_decision_row(r["symbol"], "skip_invalid", confidence, reasoning, None, snap, decision, f"position_id {position_id} not found among open {r['symbol']} positions"))
                symbol_blobs.append({"symbol": r["symbol"], "action": "skip_invalid"})
                continue
            if target.get("current_value") is None:
                decisions.append(_decision_row(r["symbol"], "skip_invalid", confidence, reasoning, target["id"], snap, decision, "MTM unavailable; cannot close"))
                symbol_blobs.append({"symbol": r["symbol"], "action": "skip_invalid"})
                continue
            cv = target["current_value"]
            closes.append({"position_id": target["id"], "exit_proceeds": cv, "realized_pnl": cv - target["entry_cost"]})
            cash += cv
            final_open.pop(target["id"], None)
            symbol_open_cost[target["symbol"]] = symbol_open_cost.get(target["symbol"], 0.0) - target["entry_cost"]
            decisions.append(_decision_row(r["symbol"], "close", confidence, reasoning, target["id"], snap, decision, None))
            symbol_blobs.append({"symbol": r["symbol"], "action": "close", "realized": cv - target["entry_cost"]})
            continue

        if action == "open":
            open_legs = decision.get("open_legs")
            proposal = (
                {"strategy": str(decision["open_strategy"]), "qty": to_num(decision.get("open_qty"), 1), "legs": open_legs}
                if decision.get("open_strategy") and isinstance(open_legs, list)
                else None
            )
            if not proposal or not isinstance(proposal["legs"], list):
                decisions.append(_decision_row(r["symbol"], "skip_invalid", confidence, reasoning, None, snap, decision, "missing open_strategy or open_legs"))
                symbol_blobs.append({"symbol": r["symbol"], "action": "skip_invalid"})
                continue
            floor = agent["preset"]["min_confidence_to_trade"]
            if confidence is None or confidence < floor:
                decisions.append(_decision_row(r["symbol"], "skip_low_confidence", confidence, reasoning, None, snap, decision, f"confidence {confidence} < floor {floor}"))
                symbol_blobs.append({"symbol": r["symbol"], "action": "skip_low_confidence"})
                continue
            refilled = []
            for l in proposal["legs"]:
                leg = dict(l)
                leg["sign"] = int(to_num(leg.get("sign"), 0))
                leg["qty"] = to_num(leg.get("qty"), 0)
                if leg.get("strike") is not None:
                    leg["strike"] = to_num(leg.get("strike"))
                if leg.get("instrument") == "stock":
                    leg["fill_price"] = r["spot"]
                    leg["current_price"] = r["spot"]
                else:
                    c = next((x for x in r["contracts"] if x["symbol"] == leg.get("symbol")), None)
                    m_ = mid_of(c) if c else None
                    fp = m_ if m_ is not None else to_num(leg.get("fill_price"), 0.0)
                    leg["fill_price"] = fp
                    leg["current_price"] = fp
                refilled.append(leg)
            qty = int(proposal["qty"] or 1)
            pre = pre_validate_open(
                {"strategy": proposal["strategy"], "legs": refilled, "qty": qty},
                agent["preset"],
                agent,
                snap["ivHvRatio"],
                (r["iv_rank_info"] or {}).get("rank"),
            )
            if not pre["ok"]:
                decisions.append(_decision_row(r["symbol"], "skip_invalid", confidence, reasoning, None, snap, decision, pre["reason"]))
                symbol_blobs.append({"symbol": r["symbol"], "action": "skip_invalid", "reason": pre["reason"]})
                continue
            open_candidates.append(
                {
                    "symbol": r["symbol"],
                    "strategy": proposal["strategy"],
                    "refilled_legs": refilled,
                    "confidence": confidence,
                    "reasoning": reasoning,
                    "decision": decision,
                    "snapshot": snap,
                    "reserved_collateral": pre["reserved_collateral"],
                    "cost": pre["computed_entry_cost"],
                }
            )
            continue

        decisions.append(_decision_row(r["symbol"], "skip_invalid", confidence, reasoning, None, snap, decision, f"unknown action: {action}"))
        symbol_blobs.append({"symbol": r["symbol"], "action": "skip_invalid"})

    # Ranked commit — highest-confidence opens win the scarce slots/cash/headroom.
    open_candidates.sort(key=lambda c: c["confidence"], reverse=True)
    cap = agent["preset"]["max_concurrent_positions"]
    sym_cap = agent["starting_capital"] * agent["preset"]["max_concentration_per_symbol_pct"]
    new_counter = 0
    for cand in open_candidates:
        reasons = []
        if len(final_open) >= cap:
            reasons.append(f"at max concurrent positions ({cap})")
        if cand["cost"] > cash:
            reasons.append(f"insufficient cash after prior commits: needs {cand['cost']:.0f}, have {cash:.0f}")
        sym_running = symbol_open_cost.get(cand["symbol"], 0.0)
        if sym_running + cand["cost"] > sym_cap:
            reasons.append(f"concentration on {cand['symbol']} would be {(sym_running + cand['cost']):.0f}, cap {sym_cap:.0f}")
        if reasons:
            note = "outranked by higher-confidence opens: " + "; ".join(reasons)
            decisions.append(_decision_row(cand["symbol"], "skip_outranked", cand["confidence"], cand["reasoning"], None, cand["snapshot"], cand["decision"], note))
            symbol_blobs.append({"symbol": cand["symbol"], "action": "skip_outranked", "reason": note})
            continue
        opens.append(
            {
                "symbol": cand["symbol"],
                "strategy": cand["strategy"],
                "legs": cand["refilled_legs"],
                "reserved_collateral": cand["reserved_collateral"],
                "entry_cost": cand["cost"],
                "rationale": cand["reasoning"],
                "_decision": {
                    "action": "open",
                    "confidence": cand["confidence"],
                    "reasoning": cand["reasoning"],
                    "snapshot": cand["snapshot"],
                    "raw_response": cand["decision"],
                    "validation_notes": None,
                },
            }
        )
        cash -= cand["cost"]
        new_counter += 1
        final_open[f"new-{new_counter}"] = {"entry_cost": cand["cost"], "current_value": cand["cost"]}
        symbol_open_cost[cand["symbol"]] = sym_running + cand["cost"]
        symbol_blobs.append({"symbol": cand["symbol"], "action": "open", "strategy": cand["strategy"], "entry_cost": cand["cost"]})

    positions_mtm = sum((p["current_value"] if p["current_value"] is not None else p["entry_cost"]) for p in final_open.values())
    total_equity = cash + positions_mtm

    payload = {
        "agent_id": agent["id"],
        "run_date": run_date,
        "final_cash": cash,
        "expires": expires,
        "mtm_updates": mtm_updates,
        "closes": closes,
        "opens": opens,
        "decisions": decisions,
        "equity": {
            "cash": cash,
            "positions_mtm": positions_mtm,
            "total_equity": total_equity,
            "open_positions": len(final_open),
        },
    }

    if dry_run:
        applied = {"dry_run": True}
    else:
        applied = db.db_rpc(env, "apply_agent_tick", {"payload": payload})

    return {
        "agent": agent["slug"],
        "cash": cash,
        "positions_mtm": positions_mtm,
        "total_equity": total_equity,
        "open_positions": len(final_open),
        "applied": applied,
        "actions": symbol_blobs,
        "payload": payload if dry_run else None,
    }


def _decision_row(symbol, action, confidence, reasoning, position_id, snapshot, raw_response, validation_notes):
    return {
        "symbol": symbol,
        "action": action,
        "confidence": confidence,
        "reasoning": reasoning,
        "position_id": position_id,
        "snapshot": snapshot,
        "raw_response": raw_response,
        "validation_notes": validation_notes,
    }
