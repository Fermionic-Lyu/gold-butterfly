// Operator CLI. Inside the deployed container (via `insta compute exec`) or
// locally against a running dev server:
//
//   node /app/dist-server/cli.js run <job> ['{"force":true}'] [--no-wait]
//   node /app/dist-server/cli.js migrate | seed
//
// `run` talks to the live server over loopback so the job executes in the
// server process, under the same lock and logging as scheduled runs.

import { env } from "./env.ts";

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "run": {
      const name = rest[0];
      if (!name) throw new Error("usage: run <job> [jsonArgs] [--no-wait]");
      const wait = !rest.includes("--no-wait");
      const argJson = rest.slice(1).find((a) => !a.startsWith("--")) ?? "{}";
      const args = JSON.parse(argJson);
      const url = `http://127.0.0.1:${env.port}/api/jobs/${encodeURIComponent(name)}/run${wait ? "?wait=1" : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(wait ? 170_000 : 15_000),
      }).catch((e) => {
        if (e?.name === "TimeoutError") {
          console.log(`still running — check GET /api/jobs/runs?job=${name}&limit=1`);
          process.exit(0);
        }
        throw e;
      });
      const body = await res.text();
      console.log(body);
      process.exit(res.ok ? 0 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case "migrate": {
      const { migrate, pool } = await import("./db.ts");
      const ran = await migrate();
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
      await pool.end();
      return;
    }
    case "seed": {
      const { pool } = await import("./db.ts");
      const { seed } = await import("./seed.ts");
      console.log(await seed());
      await pool.end();
      return;
    }
    default:
      console.error("usage: cli <run|migrate|seed> ...");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
