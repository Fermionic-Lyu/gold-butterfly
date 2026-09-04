import { Router } from "express";
import { requireAuth } from "../auth.ts";
import { execute, query } from "../db.ts";

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

subscriptionsRouter.get("/", async (req, res) => {
  res.json(await query("SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at ASC", [req.user!.id]));
});

subscriptionsRouter.post("/", async (req, res) => {
  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return void res.status(400).json({ error: "Invalid symbol." });
  const rows = await query(
    "INSERT INTO subscriptions (user_id, symbol) VALUES ($1, $2) ON CONFLICT (user_id, symbol) DO NOTHING RETURNING *",
    [req.user!.id, symbol],
  );
  if (!rows[0]) return void res.status(409).json({ error: `${symbol} is already in your watchlist.` });
  res.status(201).json(rows[0]);
});

subscriptionsRouter.delete("/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return void res.status(400).json({ error: "invalid id" });
  const n = await execute("DELETE FROM subscriptions WHERE id = $1 AND user_id = $2", [id, req.user!.id]);
  if (n === 0) return void res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});
