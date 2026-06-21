"""Pricing, valuation, mark-to-market, and contract-selection helpers.

Legs/contracts/positions are plain dicts (they arrive as JSON). A leg is:
  {sign: 1|-1, qty, instrument: stock|call|put, symbol, strike?, expiration?,
   fill_price, current_price?}
A chain contract is:
  {symbol(OCC), expiration, strike, type: call|put, bid, ask, delta, iv}
"""

from __future__ import annotations

import math

from .util import days_to_expiration, expiration_passed, to_num


def multiplier(instrument: str) -> int:
    return 1 if instrument == "stock" else 100


def leg_value(leg: dict, price: float) -> float:
    return leg["sign"] * leg["qty"] * price * multiplier(leg["instrument"])


def entry_cost(legs: list[dict], collateral: float) -> float:
    return sum(leg_value(l, l["fill_price"]) for l in legs) + collateral


def current_value(legs: list[dict], collateral: float) -> float:
    total = 0.0
    for l in legs:
        cp = l.get("current_price")
        price = l["fill_price"] if cp is None else cp
        total += leg_value(l, price)
    return total + collateral


def mid_of(c: dict):
    bid, ask = c.get("bid"), c.get("ask")
    if bid is not None and ask is not None and bid >= 0 and ask >= 0:
        if ask == 0:
            return None
        return (bid + ask) / 2
    return None


def hv30_from_closes(closes: list[float]):
    if len(closes) < 11:
        return None
    s = closes[-31:]
    rets = [math.log(s[i] / s[i - 1]) for i in range(1, len(s))]
    mean = sum(rets) / len(rets)
    variance = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(variance) * math.sqrt(252)


def nearest_by_delta(contracts: list[dict], target: float):
    best, best_diff = None, math.inf
    for c in contracts:
        if c.get("delta") is None:
            continue
        diff = abs(c["delta"] - target)
        if diff < best_diff:
            best, best_diff = c, diff
    return best


def nearest_by_strike(contracts: list[dict], spot: float):
    best, best_diff = None, math.inf
    for c in contracts:
        diff = abs(c["strike"] - spot)
        if diff < best_diff:
            best, best_diff = c, diff
    return best


def nearest_expiration(expirations: list[str], target_days: float):
    if not expirations:
        return None
    best, best_diff = expirations[0], math.inf
    for e in expirations:
        diff = abs(days_to_expiration(e) - target_days)
        if diff < best_diff:
            best, best_diff = e, diff
    return best


def price_leg(leg: dict, spot, contracts: list[dict]):
    if leg["instrument"] == "stock":
        return spot
    c = next((x for x in contracts if x["symbol"] == leg["symbol"]), None)
    return mid_of(c) if c else None


def mark_to_market_position(pos: dict, spot, contracts: list[dict]) -> dict:
    """Re-price every leg. Expired legs settle to intrinsic; live legs take the
    chain mid (falling back to last known / fill). current_value is None unless
    every leg priced — matching the TS `allPriced` guard."""
    expired_legs: list[dict] = []
    updated: list[dict] = []
    for leg in pos["legs"]:
        if leg.get("expiration") and expiration_passed(leg["expiration"]):
            strike = leg.get("strike")
            if spot is not None and strike is not None:
                intrinsic = (
                    max(0.0, spot - strike)
                    if leg["instrument"] == "call"
                    else max(0.0, strike - spot)
                )
            else:
                intrinsic = 0.0
            nl = {**leg, "current_price": intrinsic}
            expired_legs.append(nl)
            updated.append(nl)
        else:
            px = price_leg(leg, spot, contracts)
            if px is None:
                px = leg.get("current_price")
                if px is None:
                    px = leg["fill_price"]
            updated.append({**leg, "current_price": px})

    all_priced = all(isinstance(l.get("current_price"), (int, float)) for l in updated)
    cv = current_value(updated, to_num(pos.get("reserved_collateral"), 0.0)) if all_priced else None
    return {"current_value": cv, "legs": updated, "expired_legs": expired_legs}
