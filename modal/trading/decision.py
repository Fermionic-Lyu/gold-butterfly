"""LLM decision contract: the structured-output schema, the per-symbol user
prompt, and a tolerant JSON extractor."""

from __future__ import annotations

import json

from .util import days_to_expiration

# Flat schema enforced via OpenRouter structured outputs (strict json_schema).
# Fields irrelevant to the chosen action are null; strategy/sign/instrument are
# validated semantically in code, not at the schema layer. (See the long note
# in the TS original for why the shape is flat.)
DECISION_SCHEMA = {
    "name": "agent_decision",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {"type": "string", "description": "open | close | hold"},
            "confidence": {"type": "number"},
            "reasoning": {"type": "string", "description": "≤50 words"},
            "open_strategy": {
                "type": ["string", "null"],
                "description": "Required when action is open: one of allowed_strategies. Null otherwise.",
            },
            "open_qty": {
                "type": ["number", "null"],
                "description": "Required when action is open: integer ≥ 1. Null otherwise.",
            },
            "open_legs": {
                "type": ["array", "null"],
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "sign": {"type": "number", "description": "1 for long, -1 for short"},
                        "qty": {"type": "number"},
                        "instrument": {"type": "string", "description": "stock | call | put"},
                        "symbol": {
                            "type": "string",
                            "description": "OCC symbol for options, ticker for stock",
                        },
                        "strike": {"type": ["number", "null"]},
                        "expiration": {
                            "type": ["string", "null"],
                            "description": "YYYY-MM-DD for options, null for stock",
                        },
                        "fill_price": {"type": "number"},
                    },
                    "required": [
                        "sign",
                        "qty",
                        "instrument",
                        "symbol",
                        "strike",
                        "expiration",
                        "fill_price",
                    ],
                },
                "description": "Required when action is open. Null otherwise.",
            },
            "close_position_id": {
                "type": ["string", "null"],
                "description": "Required when action is close: UUID of YOUR open position on this symbol. Null otherwise.",
            },
            "close_reason": {
                "type": ["string", "null"],
                "description": "Required when action is close: ≤30 words. Null otherwise.",
            },
        },
        "required": [
            "action",
            "confidence",
            "reasoning",
            "open_strategy",
            "open_qty",
            "open_legs",
            "close_position_id",
            "close_reason",
        ],
    },
}

DAILY_CADENCE_ADDENDUM = "\n".join(
    [
        "TRADING CADENCE — IMPORTANT:",
        "You evaluate this symbol exactly once per US trading day, after the market close.",
        "You will not be called again on this symbol until tomorrow's close.",
        "There is no intraday reaction available to you. Size, structure, and stop-management",
        "must assume daily-only review until the position is closed.",
        "",
    ]
)


def build_user_prompt(
    *,
    symbol,
    preset,
    starting_capital,
    cash,
    total_equity,
    open_count,
    this_symbol_open,
    recent_closed,
    market_snapshot,
    iv_rank,
    news=None,
):
    portfolio = {
        "starting_capital": starting_capital,
        "cash": cash,
        "total_equity": total_equity,
        "open_positions_count": open_count,
        "open_positions_on_this_symbol": [
            {
                "id": p["id"],
                "strategy": p["strategy"],
                "opened_at": p.get("opened_at"),
                "dte": round(days_to_expiration(p["legs"][0]["expiration"]))
                if p.get("legs") and p["legs"][0].get("expiration")
                else None,
                "legs": [
                    {
                        "sign": l["sign"],
                        "qty": l["qty"],
                        "instrument": l["instrument"],
                        "symbol": l["symbol"],
                        "strike": l.get("strike"),
                        "expiration": l.get("expiration"),
                        "fill_price": l["fill_price"],
                        "current_price": l.get("current_price"),
                    }
                    for l in p["legs"]
                ],
                "entry_cost": p["entry_cost"],
                "current_value": p.get("current_value"),
                "unrealized_pnl": (p["current_value"] - p["entry_cost"])
                if p.get("current_value") is not None
                else None,
                "unrealized_pnl_pct": (
                    (p["current_value"] - p["entry_cost"]) / p["entry_cost"]
                    if p.get("current_value") is not None and p["entry_cost"] > 0
                    else None
                ),
            }
            for p in this_symbol_open
        ],
    }

    constraints = {
        "max_concurrent_positions": preset["max_concurrent_positions"],
        "max_position_size_usd": starting_capital * preset["max_position_size_pct"],
        "max_concentration_per_symbol_usd": starting_capital
        * preset["max_concentration_per_symbol_pct"],
        "min_confidence_to_trade": preset["min_confidence_to_trade"],
        "dte_window": [preset["min_dte"], preset["max_dte"]],
        "allowed_strategies": preset["allowed_strategies"],
        "vol_view_required": preset.get("vol_view_required") or "any",
        "profit_target_pct": preset.get("profit_target_pct"),
        "manage_at_dte": preset.get("manage_at_dte"),
    }

    snap_with_rank = {**market_snapshot, "ivRank": iv_rank}

    if news:
        news_block = json.dumps(
            {
                "as_of_date": news.get("as_of_date"),
                "sentiment": news.get("sentiment"),
                "sentiment_score": news.get("sentiment_score"),
                "summary": news.get("summary"),
                "key_points": news.get("key_points"),
                "options_impact": news.get("options_impact"),
                "article_count": news.get("article_count"),
            },
            indent=2,
        )
    else:
        news_block = "none available for this symbol today"

    return f"""Symbol under consideration: {symbol}

PORTFOLIO STATE:
{json.dumps(portfolio, indent=2)}

RECENTLY CLOSED ON {symbol} (last 5):
{json.dumps(recent_closed, indent=2)}

MARKET SNAPSHOT (end-of-day data from the most recent US close):
{json.dumps(snap_with_rank, indent=2)}

RECENT NEWS DIGEST (AI summary of today's headlines — sentiment, catalysts, and likely options impact):
{news_block}

CONSTRAINTS:
{json.dumps(constraints, indent=2)}

This is your once-per-day decision for {symbol}, made after the US close. Pick exactly one action.
Weigh the news digest alongside the market snapshot — a strong catalyst or sentiment shift can justify acting or staying out, but the structured market data remains your primary signal.

OUTPUT RULES:
- "action" is "open", "close", or "hold". "confidence" is between 0 and 1.
- When "action" is "open": fill open_strategy (from allowed_strategies), open_qty (≥1), and open_legs (each leg's OCC symbol must come from marketSnapshot.horizons[].contracts). Set close_position_id and close_reason to null.
- When "action" is "close": set close_position_id to one of the UUIDs in open_positions_on_this_symbol, and close_reason. Set open_strategy, open_qty, open_legs to null.
- When "action" is "hold": set all five open_*/close_* fields to null.
- Leg fields: sign is +1 (long) or -1 (short); instrument is "stock", "call", or "put"; fill_price is the mid quote from the snapshot for that contract.
- The response shape is enforced by structured outputs — focus on quality, not formatting."""


def extract_json(text: str):
    """Safety net for wrapper text — find a fenced block or the first balanced
    {...} object and parse it."""
    if not text:
        return None
    fenced = None
    import re

    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    candidate = m.group(1) if m else text
    start = candidate.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(candidate)):
        ch = candidate[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(candidate[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None
