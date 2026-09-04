// Public market-data reads. Everything here was anon-readable before, too.

import { Router } from "express";
import { query, queryOne } from "../db.ts";

export const dataRouter = Router();

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

function symbolParam(raw: unknown): string | null {
  const s = String(raw ?? "").toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

function intParam(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (raw: unknown): string | null => (DATE_RE.test(String(raw ?? "")) ? String(raw) : null);

dataRouter.get("/instruments", async (_req, res) => {
  res.json(
    await query(
      "SELECT symbol, name, indices, logo_url, hv30, market_cap, pe_ratio FROM instruments ORDER BY symbol",
    ),
  );
});

dataRouter.get("/chain/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const row = await queryOne<{ view: unknown }>("SELECT get_chain_view($1) AS view", [symbol]);
  if (!row?.view) {
    res
      .status(404)
      .json({ error: `No chain data available for ${symbol}. Only Nasdaq-100 symbols are currently tracked.` });
    return;
  }
  res.json(row.view);
});

dataRouter.get("/bars/daily/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const limit = intParam(req.query.limit, 2000, 5000);
  const since = dateParam(req.query.since);
  const desc = req.query.order === "desc";
  res.json(
    await query(
      `SELECT date, open, high, low, close, volume FROM daily_bars
        WHERE symbol = $1 AND ($2::date IS NULL OR date >= $2::date)
        ORDER BY date ${desc ? "DESC" : "ASC"} LIMIT $3`,
      [symbol, since, limit],
    ),
  );
});

dataRouter.get("/bars/minute/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const limit = intParam(req.query.limit, 500, 2000);
  res.json(
    await query("SELECT ts, close, volume FROM minute_bars WHERE symbol = $1 ORDER BY ts DESC LIMIT $2", [
      symbol,
      limit,
    ]),
  );
});

dataRouter.get("/iv-history/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const days = intParam(req.query.days, 380, 2000);
  res.json(
    await query(
      `SELECT captured_at, atm_iv, spot, hv30 FROM iv_snapshots
        WHERE symbol = $1 AND captured_at >= now() - ($2::int * INTERVAL '1 day')
        ORDER BY captured_at ASC LIMIT 5000`,
      [symbol, days],
    ),
  );
});

dataRouter.get("/earnings/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const from = dateParam(req.query.from);
  const to = dateParam(req.query.to);
  res.json(
    await query(
      `SELECT date, eps_estimate, eps_actual FROM earnings_dates
        WHERE symbol = $1
          AND ($2::date IS NULL OR date >= $2::date)
          AND ($3::date IS NULL OR date <= $3::date)
        ORDER BY date ASC LIMIT 50`,
      [symbol, from, to],
    ),
  );
});

dataRouter.get("/market-holidays", async (req, res) => {
  const since = dateParam(req.query.since);
  res.json(
    await query(
      `SELECT date, name, early_close_et FROM market_holidays
        WHERE $1::date IS NULL OR date >= $1::date
        ORDER BY date ASC LIMIT 500`,
      [since],
    ),
  );
});

dataRouter.get("/news/:symbol", async (req, res) => {
  const symbol = symbolParam(req.params.symbol);
  if (!symbol) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  const [analysis, items] = await Promise.all([
    queryOne("SELECT * FROM news_analyses WHERE symbol = $1 ORDER BY as_of_date DESC LIMIT 1", [symbol]),
    query(
      `SELECT id, symbol, source, headline, summary, url, image_url, category, published_at, scraped_at
         FROM company_news WHERE symbol = $1
        ORDER BY published_at DESC NULLS LAST LIMIT 40`,
      [symbol],
    ),
  ]);
  res.json({ analysis, items });
});

dataRouter.post("/watchlist/quotes", async (req, res) => {
  const raw = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
  const symbols = [...new Set(raw.map((s: unknown) => symbolParam(String(s))).filter(Boolean))].slice(0, 200);
  if (symbols.length === 0) {
    res.json({});
    return;
  }
  const row = await queryOne<{ quotes: unknown }>("SELECT get_watchlist_quotes($1::text[]) AS quotes", [symbols]);
  res.json(row?.quotes ?? {});
});
