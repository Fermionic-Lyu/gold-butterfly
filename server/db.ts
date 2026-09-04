import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "./env.ts";

const { Pool, types } = pg;

// NUMERIC and BIGINT arrive as strings by default; every consumer here does
// float math on them. DATE stays a plain YYYY-MM-DD string so it never picks
// up a local-timezone shift on the way to JSON.
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1082, (v) => v);

// idleTimeoutMillis must stay under the database's scale-to-zero window, or a
// suspended instance leaves the pool holding dead sockets.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 30_000,
  ssl: sslFor(env.databaseUrl),
});

pool.on("error", (e) => console.error("[db] idle client error", e.message));

function sslFor(url: string): pg.PoolConfig["ssl"] {
  if (!url) return undefined;
  if (/localhost|127\.0\.0\.1|@db[:/]/.test(url)) return undefined;
  if (/sslmode=disable/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

export async function queryOne<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params);
  return r.rowCount ?? 0;
}

export async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}

interface UpsertOptions {
  // Columns to overwrite on conflict; default every non-conflict column.
  update?: string[] | "none";
  // jsonb columns need explicit stringification — pg would otherwise render a
  // JS array as a Postgres array literal.
  jsonb?: string[];
  chunk?: number;
}

// Multi-row INSERT ... ON CONFLICT in parameter-bounded chunks. Rows may omit
// columns (sent as NULL). Returns the number of rows sent.
export async function bulkUpsert(
  table: string,
  columns: string[],
  rows: Row[],
  conflict: string[],
  opts: UpsertOptions = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const jsonb = new Set(opts.jsonb ?? []);
  const chunk = Math.max(1, Math.min(opts.chunk ?? 500, Math.floor(30_000 / columns.length)));
  const updateCols =
    opts.update === "none"
      ? []
      : (opts.update ?? columns.filter((c) => !conflict.includes(c)));
  const conflictClause =
    updateCols.length === 0
      ? `ON CONFLICT (${conflict.join(",")}) DO NOTHING`
      : `ON CONFLICT (${conflict.join(",")}) DO UPDATE SET ${updateCols
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", ")}`;

  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const ph = columns.map((c) => {
        let v = row[c] ?? null;
        if (v !== null && jsonb.has(c)) v = JSON.stringify(v);
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await pool.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflictClause}`,
      params,
    );
  }
  return rows.length;
}

// ---------- migrations ----------

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(`${MIGRATIONS_DIR}${f}`, "utf8");
    await withTransaction(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    ran.push(f);
    console.log(`[db] applied migration ${f}`);
  }
  return ran;
}

// ---------- app settings (server-generated secrets, flags) ----------

export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>("SELECT value FROM app_settings WHERE key = $1", [key]);
  return row?.value ?? null;
}

export async function ensureSetting(key: string, generate: () => string): Promise<string> {
  const existing = await getSetting(key);
  if (existing) return existing;
  await execute(
    "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
    [key, generate()],
  );
  return (await getSetting(key))!;
}
