"""Collateral math + the order-independent pre-validation of an open proposal.

`pre_validate_open` covers only checks that depend solely on the proposal and
the agent's starting state (strategy allowed, DTE window, vol-regime gate,
absolute size cap). The order-DEPENDENT gates (concurrent-position cap, runtime
cash, per-symbol concentration) are applied later, in the ranked commit loop in
agent.process_agent — a failure there surfaces as `skip_outranked`.
"""

from __future__ import annotations

from .pricing import entry_cost
from .util import days_to_expiration


def _find(legs, instrument, sign):
    return next((l for l in legs if l["instrument"] == instrument and l["sign"] == sign), None)


def compute_reserved_collateral(strategy: str, legs: list[dict], qty: int) -> float:
    def m(n: float) -> float:
        return n * 100 * qty

    if strategy == "cash_secured_put":
        put = _find(legs, "put", -1)
        return m(put["strike"]) if put and put.get("strike") else 0.0
    if strategy == "covered_call":
        return 0.0
    if strategy == "bull_put_credit_spread":
        sp, lp = _find(legs, "put", -1), _find(legs, "put", 1)
        if not (sp and lp and sp.get("strike") and lp.get("strike")):
            return 0.0
        return m(max(0.0, sp["strike"] - lp["strike"]))
    if strategy == "bear_call_credit_spread":
        sc, lc = _find(legs, "call", -1), _find(legs, "call", 1)
        if not (sc and lc and sc.get("strike") and lc.get("strike")):
            return 0.0
        return m(max(0.0, lc["strike"] - sc["strike"]))
    if strategy == "iron_condor":
        sc, lc = _find(legs, "call", -1), _find(legs, "call", 1)
        sp, lp = _find(legs, "put", -1), _find(legs, "put", 1)
        if not all(x and x.get("strike") for x in (sc, lc, sp, lp)):
            return 0.0
        cw = max(0.0, lc["strike"] - sc["strike"])
        pw = max(0.0, sp["strike"] - lp["strike"])
        return m(max(cw, pw))
    return 0.0


def _fail(reason, reserved=0.0, cost=0.0):
    return {"ok": False, "reason": reason, "reserved_collateral": reserved, "computed_entry_cost": cost}


def pre_validate_open(proposal: dict, preset: dict, agent: dict, iv_hv_ratio, iv_rank) -> dict:
    strategy, legs, qty = proposal["strategy"], proposal["legs"], proposal.get("qty") or 1

    if strategy not in preset["allowed_strategies"]:
        return _fail(f"strategy {strategy} not in allowed list")

    for leg in legs:
        if leg.get("expiration"):
            dte = days_to_expiration(leg["expiration"])
            if dte < preset["min_dte"] or dte > preset["max_dte"]:
                return _fail(
                    f"leg DTE {round(dte)} outside [{preset['min_dte']},{preset['max_dte']}]"
                )

    iv_hv_str = f"{iv_hv_ratio:.2f}" if iv_hv_ratio is not None else "?"
    iv_rank_str = f"{round(iv_rank * 100)}%" if iv_rank is not None else "?"
    vol_view = preset.get("vol_view_required")
    if vol_view == "rich_or_fair":
        rich_ok = iv_hv_ratio is not None and iv_hv_ratio >= 1.10
        rank_ok = iv_rank is not None and iv_rank >= 0.30
        if not rich_ok and not rank_ok:
            return _fail(
                f"vol regime cheap (IV/HV={iv_hv_str}, IVR={iv_rank_str}) — only sell premium when rich"
            )
    elif vol_view == "cheap_or_fair":
        cheap_ok = iv_hv_ratio is not None and iv_hv_ratio <= 0.95
        rank_ok = iv_rank is not None and iv_rank <= 0.25
        if not cheap_ok and not rank_ok:
            return _fail(
                f"vol regime rich/fair (IV/HV={iv_hv_str}, IVR={iv_rank_str}) — only buy premium when cheap"
            )

    reserved = compute_reserved_collateral(strategy, legs, qty)
    cost = entry_cost(legs, reserved)
    size_cap = agent["starting_capital"] * preset["max_position_size_pct"]
    if cost > size_cap:
        return _fail(f"position size {cost:.0f} exceeds cap {size_cap:.0f}", reserved, cost)
    return {"ok": True, "reserved_collateral": reserved, "computed_entry_cost": cost}
