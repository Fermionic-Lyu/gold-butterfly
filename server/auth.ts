import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { ensureSetting, queryOne } from "./db.ts";

const scrypt = promisify(scryptCb);

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser | null;
    }
  }
}

const COOKIE = "gb_session";
const SESSION_DAYS = 30;

// ---------- passwords ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const key = (await scrypt(password, Buffer.from(saltB64, "base64url"), 64)) as Buffer;
  const expected = Buffer.from(keyB64, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------- session tokens ----------

// The signing secret is generated once and kept in app_settings, so a fresh
// deploy needs no operator-provided secret and restarts keep sessions valid.
let secretCache: string | null = null;
async function sessionSecret(): Promise<string> {
  if (secretCache) return secretCache;
  secretCache = await ensureSetting("session_secret", () => randomBytes(48).toString("base64url"));
  return secretCache;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export async function signSession(userId: string): Promise<string> {
  const payload = b64(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 86_400_000 }));
  const sig = createHmac("sha256", await sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export async function verifySession(token: string): Promise<string | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", await sessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.uid !== "string" || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

// ---------- middleware ----------

export function toSessionUser(row: Record<string, any>): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    isAdmin: Boolean(row.is_admin),
  };
}

async function loadUser(req: Request): Promise<SessionUser | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const uid = await verifySession(token);
  if (!uid) return null;
  const row = await queryOne(
    "SELECT id, email, name, avatar_url, is_admin FROM users WHERE id = $1",
    [uid],
  );
  return row ? toSessionUser(row) : null;
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    req.user = await loadUser(req);
    next();
  } catch (e) {
    next(e);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    req.user = await loadUser(req);
    if (!req.user) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
