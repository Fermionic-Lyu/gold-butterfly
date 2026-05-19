// One-shot setup for a fresh InsForge project after `db migrations up`.
//
// Brings the project from "schema applied" to "fully functional":
//   1. Deploys every edge function in functions/
//   2. Seeds instruments / agents / market_holidays from data/*.json
//   3. Creates the logos storage bucket and uploads every PNG from data/logos/
//   4. Patches instruments.logo_url so the frontend can resolve each logo
//   5. Creates the cron schedules listed in schedules/schedules.mjs
//
// Each step is idempotent — re-running is safe. Reads project context from
// .insforge/project.json (the CLI link file).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { schedules as scheduleManifest, defaults as scheduleDefaults } from "../schedules/schedules.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const projectPath = join(ROOT, ".insforge/project.json");
if (!existsSync(projectPath)) {
  console.error(
    "missing .insforge/project.json — run `insforge link` to link this checkout to a project first",
  );
  process.exit(1);
}
const PROJECT = JSON.parse(readFileSync(projectPath, "utf8"));
const HOST = PROJECT.oss_host;
const KEY = PROJECT.api_key;
const auth = { Authorization: `Bearer ${KEY}` };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const BUCKET = "logos";
const LOGO_DIR = join(ROOT, "data/logos");
const FUNCTIONS_DIR = join(ROOT, "functions");

// Shell out to the InsForge CLI. We use spawn (no shell) so any value we pass
// — JSON-stringified headers/body, slugs — is delivered verbatim with no
// shell-parsing surprises. Inherits stdio for live progress output.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "@insforge/cli", ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`insforge ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
    child.on("error", reject);
  });
}

async function dbGet(path) {
  const r = await fetch(`${HOST}/api/database/records/${path}`, { headers: auth });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function dbUpsert(table, rows) {
  // PostgREST resolves conflicts on the table's primary key.
  const r = await fetch(`${HOST}/api/database/records/${table}`, {
    method: "POST",
    headers: { ...jsonAuth, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert ${table}: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

async function dbInsert(table, rows) {
  const r = await fetch(`${HOST}/api/database/records/${table}`, {
    method: "POST",
    headers: { ...jsonAuth, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`insert ${table}: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

async function dbPatch(table, filter, patch) {
  const r = await fetch(`${HOST}/api/database/records/${table}?${filter}`, {
    method: "PATCH",
    headers: jsonAuth,
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patch ${table} ${filter}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function seedInstruments() {
  const rows = JSON.parse(readFileSync(join(ROOT, "data/instruments/ndx.json"), "utf8"));
  await dbUpsert("instruments", rows);
  console.log(`✓ instruments: ${rows.length} rows upserted`);
}

async function seedAgents() {
  const file = JSON.parse(readFileSync(join(ROOT, "data/agents.json"), "utf8"));
  // agents.slug has no unique constraint, so pre-check what's already there
  // among system-owned rows (user_id IS NULL) and skip the dupes.
  const existing = await dbGet("agents?select=slug&user_id=is.null");
  const have = new Set(existing.map((r) => r.slug));
  const rows = file
    .filter((a) => !have.has(a.slug))
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      focus: a.focus,
      model: a.model,
      system_prompt: a.system_prompt,
      preset: a.preset,
      watched_symbols: a.watched_symbols,
      starting_capital: a.starting_capital,
      cash: a.starting_capital,
      active: true,
      user_id: null,
    }));
  if (rows.length === 0) {
    console.log(`✓ agents: all ${file.length} default rows already present`);
    return;
  }
  await dbInsert("agents", rows);
  console.log(`✓ agents: ${rows.length}/${file.length} inserted, ${file.length - rows.length} already existed`);
}

async function seedHolidays() {
  const rows = JSON.parse(readFileSync(join(ROOT, "data/market-holidays.json"), "utf8"));
  await dbUpsert("market_holidays", rows);
  console.log(`✓ market_holidays: ${rows.length} rows upserted`);
}

async function ensureBucket() {
  const r = await fetch(`${HOST}/api/storage/buckets`, { headers: auth });
  if (!r.ok) throw new Error(`list buckets ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const list = Array.isArray(data) ? data : data?.buckets ?? [];
  if (list.some((b) => (b.name ?? b.bucket_name) === BUCKET)) {
    console.log(`✓ storage bucket "${BUCKET}" already exists`);
    return;
  }
  const c = await fetch(`${HOST}/api/storage/buckets`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name: BUCKET, public: true }),
  });
  if (!c.ok) throw new Error(`create bucket ${c.status}: ${await c.text()}`);
  console.log(`✓ created storage bucket "${BUCKET}"`);
}

async function uploadLogo(filePath) {
  const symbol = basename(filePath, ".png");
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), `${symbol}.png`);
  // PUT to /objects/{key} preserves the symbol-keyed URL (POST auto-generates).
  const r = await fetch(`${HOST}/api/storage/buckets/${BUCKET}/objects/${symbol}.png`, {
    method: "PUT",
    headers: auth,
    body: form,
  });
  if (!r.ok) return { symbol, ok: false, error: `${r.status} ${(await r.text()).slice(0, 120)}` };
  return { symbol, ok: true };
}

async function uploadLogosAndPatchUrls() {
  if (!existsSync(LOGO_DIR)) {
    console.log(`⚠ ${LOGO_DIR} missing — skipping logo upload`);
    return;
  }
  const files = readdirSync(LOGO_DIR).filter((f) => f.endsWith(".png"));
  const ok = [];
  const err = [];
  const CHUNK = 8;
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    const out = await Promise.all(batch.map((f) => uploadLogo(join(LOGO_DIR, f))));
    for (const r of out) (r.ok ? ok : err).push(r);
  }
  console.log(`✓ logos uploaded: ${ok.length}, failed: ${err.length}`);
  if (err.length) console.log("  errors:", err.slice(0, 3));

  for (const { symbol } of ok) {
    const url = `${HOST}/api/storage/buckets/${BUCKET}/objects/${symbol}.png`;
    try {
      await dbPatch("instruments", `symbol=eq.${symbol}`, { logo_url: url });
    } catch (e) {
      console.log(`  ✗ patch logo_url ${symbol}: ${e.message}`);
    }
  }
  console.log(`✓ instruments.logo_url patched for ${ok.length} symbols`);
}

async function deployFunctions() {
  const files = readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".ts"));
  console.log(`deploying ${files.length} edge functions sequentially...`);
  let ok = 0;
  const failures = [];
  for (const f of files) {
    const slug = basename(f, ".ts");
    try {
      await runCli(["functions", "deploy", slug, "--file", `functions/${f}`]);
      ok++;
      process.stdout.write(`  ✓ ${slug}\n`);
    } catch (e) {
      failures.push({ slug, error: e.message });
      process.stdout.write(`  ✗ ${slug}: ${e.message.slice(0, 200)}\n`);
    }
  }
  console.log(`✓ functions: ${ok} deployed, ${failures.length} failed`);
  if (failures.length) {
    console.log("  failed slugs:", failures.map((x) => x.slug).join(", "));
  }
}

async function applySchedules() {
  // Pull existing schedules so we can skip names that are already there.
  const r = await fetch(`${HOST}/api/schedules`, { headers: auth });
  const existingNames = new Set();
  if (r.ok) {
    const body = await r.json();
    const list = Array.isArray(body) ? body : body?.schedules ?? body?.data ?? [];
    for (const s of list) {
      const name = s?.name ?? s?.schedule_name;
      if (name) existingNames.add(name);
    }
  }

  let created = 0;
  let skipped = 0;
  for (const s of scheduleManifest) {
    if (existingNames.has(s.name)) {
      skipped++;
      continue;
    }
    const url = `${HOST}/functions/${s.function}`;
    const method = s.method ?? scheduleDefaults.method;
    const headers = { ...scheduleDefaults.headers, ...(s.headers ?? {}) };
    const body = s.body ?? {};
    try {
      await runCli([
        "schedules",
        "create",
        "--name",
        s.name,
        "--cron",
        s.cron,
        "--url",
        url,
        "--method",
        method,
        "--headers",
        JSON.stringify(headers),
        "--body",
        JSON.stringify(body),
      ]);
      created++;
      process.stdout.write(`  ✓ created '${s.name}' (${s.cron})\n`);
    } catch (e) {
      process.stdout.write(`  ✗ '${s.name}': ${e.message.slice(0, 200)}\n`);
    }
  }
  console.log(`✓ schedules: ${created} created, ${skipped} already existed`);
}

async function main() {
  console.log(`setting up project: ${PROJECT.project_name} (${PROJECT.appkey})`);
  await deployFunctions();
  await seedInstruments();
  await seedAgents();
  await seedHolidays();
  await ensureBucket();
  await uploadLogosAndPatchUrls();
  await applySchedules();
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
