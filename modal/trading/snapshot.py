"""Build the per-symbol regime snapshot handed to the agent's LLM."""

from __future__ import annotations

from .pricing import mid_of, nearest_by_delta, nearest_by_strike, nearest_expiration
from .util import days_to_expiration

_HORIZONS = [("near", 21), ("primary", 35), ("long", 49)]
_DELTA_TAGS = [
    ("call_30d", "call", 0.30),
    ("call_20d", "call", 0.20),
    ("call_16d", "call", 0.16),
    ("call_10d", "call", 0.10),
    ("put_30d", "put", -0.30),
    ("put_20d", "put", -0.20),
    ("put_16d", "put", -0.16),
    ("put_10d", "put", -0.10),
]


def build_symbol_snapshot(symbol: str, spot, contracts: list[dict], hv30) -> dict:
    expirations = sorted({c["expiration"] for c in contracts})
    horizons = []
    for tag, days in _HORIZONS:
        exp = nearest_expiration(expirations, days)
        if exp:
            horizons.append({"tag": tag, "days": days, "expiration": exp})

    horizon_contracts = []
    for h in horizons:
        exp = h["expiration"]
        calls = [c for c in contracts if c["type"] == "call" and c["expiration"] == exp]
        puts = [c for c in contracts if c["type"] == "put" and c["expiration"] == exp]
        picks = []
        for tag, kind, target in _DELTA_TAGS:
            pool = calls if kind == "call" else puts
            c = nearest_by_delta(pool, target)
            if c is not None:
                picks.append(
                    {
                        "tag": tag,
                        "symbol": c["symbol"],
                        "type": c["type"],
                        "strike": c["strike"],
                        "delta": c.get("delta"),
                        "iv": c.get("iv"),
                        "bid": c.get("bid"),
                        "ask": c.get("ask"),
                        "mid": mid_of(c),
                    }
                )
        horizon_contracts.append(
            {
                "tag": h["tag"],
                "expiration": exp,
                "days": round(days_to_expiration(exp)),
                "contracts": picks,
            }
        )

    atm_iv = None
    primary = next((h["expiration"] for h in horizons if h["tag"] == "primary"), None)
    if spot is not None and primary:
        c = nearest_by_strike(
            [x for x in contracts if x["type"] == "call" and x["expiration"] == primary], spot
        )
        p = nearest_by_strike(
            [x for x in contracts if x["type"] == "put" and x["expiration"] == primary], spot
        )
        civ = c.get("iv") if c else None
        piv = p.get("iv") if p else None
        if civ is not None and piv is not None:
            atm_iv = (civ + piv) / 2
        else:
            atm_iv = civ if civ is not None else piv

    iv_hv_ratio = atm_iv / hv30 if (atm_iv is not None and hv30) else None
    return {
        "symbol": symbol,
        "spot": spot,
        "atmIV": atm_iv,
        "hv30": hv30,
        "ivHvRatio": iv_hv_ratio,
        "horizons": horizon_contracts,
    }
