import { Router } from "express";
import { optionalAuth, requireAuth } from "../auth.ts";
import { execute, query, queryOne } from "../db.ts";

export const agentsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (raw: unknown) => (UUID_RE.test(String(raw ?? "")) ? String(raw) : null);

// Defaults (user_id NULL) are visible to everyone; custom agents only to their owner.
agentsRouter.get("/", optionalAuth, async (req, res) => {
  const rows = req.user
    ? await query("SELECT * FROM agents WHERE active AND (user_id IS NULL OR user_id = $1) ORDER BY created_at", [
        req.user.id,
      ])
    : await query("SELECT * FROM agents WHERE active AND user_id IS NULL ORDER BY created_at");
  res.json(rows);
});

agentsRouter.get("/summary", async (_req, res) => {
  const row = await queryOne<{ summary: unknown }>("SELECT get_agents_summary() AS summary");
  res.json(row?.summary ?? {});
});

agentsRouter.get("/:id/equity", async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  res.json(
    await query("SELECT * FROM equity_snapshots WHERE agent_id = $1 ORDER BY recorded_at ASC LIMIT 2000", [id]),
  );
});

agentsRouter.get("/:id/positions", async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const status = ["open", "closed", "expired"].includes(String(req.query.status)) ? String(req.query.status) : null;
  res.json(
    await query(
      `SELECT * FROM positions WHERE agent_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY opened_at DESC LIMIT 200`,
      [id, status],
    ),
  );
});

agentsRouter.get("/:id/decisions", async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 500), 2000);
  res.json(
    await query(
      `SELECT id, agent_id, symbol, decided_at, run_date, action, confidence, reasoning, position_id, validation_notes
         FROM decisions WHERE agent_id = $1 ORDER BY decided_at DESC LIMIT $2`,
      [id, limit],
    ),
  );
});

const FOCUS = new Set(["premium_seller", "long_vol", "directional_momentum"]);
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

agentsRouter.post("/", requireAuth, async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim().slice(0, 64);
  const focus = String(b.focus ?? "");
  const model = String(b.model ?? "").trim();
  const systemPrompt = String(b.systemPrompt ?? "");
  const watched = Array.isArray(b.watchedSymbols)
    ? [...new Set(b.watchedSymbols.map((s: unknown) => String(s).toUpperCase()).filter((s: string) => SYMBOL_RE.test(s)))]
    : [];
  const startingCapital = Number(b.startingCapital);
  if (!name) return void res.status(400).json({ error: "Name is required." });
  if (!FOCUS.has(focus)) return void res.status(400).json({ error: "Unknown strategy focus." });
  if (!model || model.length > 100) return void res.status(400).json({ error: "Model is required." });
  if (!systemPrompt || systemPrompt.length > 20_000) return void res.status(400).json({ error: "System prompt is required." });
  if (!b.preset || typeof b.preset !== "object") return void res.status(400).json({ error: "Preset is required." });
  if (watched.length === 0 || watched.length > 10) return void res.status(400).json({ error: "Pick 1–10 symbols to watch." });
  if (!Number.isFinite(startingCapital) || startingCapital < 1000 || startingCapital > 1_000_000) {
    return void res.status(400).json({ error: "Starting capital must be between 1,000 and 1,000,000." });
  }

  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = `${safeName || "agent"}-${Math.random().toString(36).slice(2, 6)}`;
    const rows = await query(
      `INSERT INTO agents (user_id, slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9,true)
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [req.user!.id, slug, name, focus, model, systemPrompt, JSON.stringify(b.preset), watched, startingCapital],
    );
    if (rows[0]) return void res.status(201).json(rows[0]);
  }
  res.status(500).json({ error: "Could not allocate a unique slug; try again." });
});

agentsRouter.delete("/:id", requireAuth, async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return void res.status(400).json({ error: "invalid id" });
  const n = await execute("DELETE FROM agents WHERE id = $1 AND user_id = $2", [id, req.user!.id]);
  if (n === 0) return void res.status(404).json({ error: "Agent not found." });
  res.json({ ok: true });
});
