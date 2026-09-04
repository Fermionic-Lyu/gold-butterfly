// Reference data from data/*.json → instruments, default agents, holidays.
// Idempotent: live-updated columns (hv30, fundamentals) are never clobbered.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bulkUpsert, pool } from "./db.ts";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(`${DATA_DIR}${rel}`, "utf8"));

// Logos ship in the frontend bundle (public/logos → dist/logos).
const LOGO_DIRS = ["../dist/logos/", "../public/logos/"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const hasLogo = (symbol: string) => LOGO_DIRS.some((d) => existsSync(`${d}${symbol}.png`));

export async function seed() {
  // Every data/instruments/*.json is part of the tracked universe.
  const instruments = readdirSync(`${DATA_DIR}instruments`)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => readJson(`instruments/${f}`) as any[])
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      name: r.name,
      indices: r.indices ?? [],
      logo_url: r.logo_url ?? (hasLogo(String(r.symbol).toUpperCase()) ? `/logos/${String(r.symbol).toUpperCase()}.png` : null),
      hv30: r.hv30 ?? null,
      market_cap: r.market_cap ?? null,
      pe_ratio: r.pe_ratio ?? null,
    }));
  const params: unknown[] = [];
  const tuples = instruments.map((i) => {
    params.push(i.symbol, i.name, i.indices, i.logo_url, i.hv30, i.market_cap, i.pe_ratio);
    const b = params.length - 7;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
  });
  await pool.query(
    `INSERT INTO instruments (symbol, name, indices, logo_url, hv30, market_cap, pe_ratio)
     VALUES ${tuples.join(",")}
     ON CONFLICT (symbol) DO UPDATE SET
       name = EXCLUDED.name,
       indices = EXCLUDED.indices,
       logo_url = EXCLUDED.logo_url,
       hv30 = COALESCE(instruments.hv30, EXCLUDED.hv30),
       market_cap = COALESCE(instruments.market_cap, EXCLUDED.market_cap),
       pe_ratio = COALESCE(instruments.pe_ratio, EXCLUDED.pe_ratio)`,
    params,
  );

  const agents = readJson("agents.json") as any[];
  let agentsInserted = 0;
  for (const a of agents) {
    const r = await pool.query(
      `INSERT INTO agents (slug, name, focus, model, system_prompt, preset, watched_symbols, starting_capital, cash, active, user_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8,true,NULL)
       ON CONFLICT (slug) DO NOTHING`,
      [a.slug, a.name, a.focus, a.model, a.system_prompt, JSON.stringify(a.preset), a.watched_symbols, a.starting_capital],
    );
    agentsInserted += r.rowCount ?? 0;
  }

  const holidays = readJson("market-holidays.json") as any[];
  await bulkUpsert("market_holidays", ["date", "name", "early_close_et"], holidays, ["date"], { update: "none" });

  console.log(`[seed] instruments=${instruments.length} agents+${agentsInserted} holidays=${holidays.length}`);
  return { instruments: instruments.length, agentsInserted, holidays: holidays.length };
}
