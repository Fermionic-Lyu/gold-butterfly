import { Router } from "express";
import {
  clearSessionCookie,
  hashPassword,
  optionalAuth,
  setSessionCookie,
  signSession,
  toSessionUser,
  verifyPassword,
} from "../auth.ts";
import { queryOne, withTransaction } from "../db.ts";

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readCredentials(body: any): { email: string; password: string } | { error: string } {
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email address." };
  if (password.length < 6) return { error: "Password must be at least 6 characters." };
  if (password.length > 200) return { error: "Password is too long." };
  return { email, password };
}

authRouter.get("/me", optionalAuth, (req, res) => {
  res.json({ user: req.user ?? null });
});

authRouter.post("/signup", async (req, res) => {
  const creds = readCredentials(req.body);
  if ("error" in creds) {
    res.status(400).json({ error: creds.error });
    return;
  }
  const passwordHash = await hashPassword(creds.password);
  // The first account to register administers the instance (can trigger jobs).
  const row = await withTransaction(async (c) => {
    await c.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
    const count = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    const isAdmin = (count.rows[0]?.n ?? 0) === 0;
    const inserted = await c.query(
      `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name, avatar_url, is_admin`,
      [creds.email, passwordHash, isAdmin],
    );
    return inserted.rows[0] ?? null;
  });
  if (!row) {
    res.status(409).json({ error: "An account with that email already exists." });
    return;
  }
  setSessionCookie(req, res, await signSession(row.id));
  res.status(201).json({ user: toSessionUser(row) });
});

authRouter.post("/signin", async (req, res) => {
  const creds = readCredentials(req.body);
  if ("error" in creds) {
    res.status(400).json({ error: creds.error });
    return;
  }
  const row = await queryOne(
    "SELECT id, email, name, avatar_url, is_admin, password_hash FROM users WHERE email = $1",
    [creds.email],
  );
  if (!row || !(await verifyPassword(creds.password, row.password_hash))) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }
  setSessionCookie(req, res, await signSession(row.id));
  res.json({ user: toSessionUser(row) });
});

authRouter.post("/signout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
