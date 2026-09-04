// Gold Butterfly server: REST API + static frontend + in-process scheduler.
//
// The port opens before migrations run so the platform's health probe sees a
// listener immediately; /api answers 503 until the schema and seed are in.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { credentialStatus, env } from "./env.ts";
import { execute, migrate, pool } from "./db.ts";
import { runJob, startScheduler, stopScheduler } from "./jobs/index.ts";
import { agentsRouter } from "./routes/agents.ts";
import { authRouter } from "./routes/auth.ts";
import { dataRouter } from "./routes/data.ts";
import { jobsRouter } from "./routes/jobs.ts";
import { strategyRouter } from "./routes/strategy.ts";
import { subscriptionsRouter } from "./routes/subscriptions.ts";
import { seed } from "./seed.ts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const INDEX_HTML = `${DIST}index.html`;
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "0";
  } catch {
    return "0";
  }
})();

let ready = false;
let bootError: string | null = null;
const startedAt = Date.now();

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.status(ready ? 200 : 503).json({
    ok: ready,
    ready,
    error: bootError,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    credentials: credentialStatus(),
    scheduler: env.schedulerEnabled,
  });
});

app.use("/api", (_req, res, next) => {
  if (!ready) {
    res.status(503).json({ error: bootError ? `startup failed: ${bootError}` : "starting up" });
    return;
  }
  next();
});
app.use("/api/auth", authRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/strategy-analyses", strategyRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api", dataRouter);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

if (existsSync(INDEX_HTML)) {
  app.use(
    express.static(DIST, {
      index: false,
      setHeaders(res, path) {
        // Vite hashes everything under /assets; index.html must never be cached.
        if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  // Relative to `root`: send's dotfile check then only sees "index.html", so a
  // checkout under a dot-directory still serves.
  app.get("/{*splat}", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile("index.html", { root: DIST });
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send("Gold Butterfly API is running; the frontend bundle is not built (run `npm run build`).");
  });
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error("[http]", err);
  res.status(status).json({ error: status >= 500 ? "internal error" : String(err?.message ?? "request error") });
});

const server = app.listen(env.port, "::", () => {
  console.log(`[http] listening on :${env.port} (${env.nodeEnv})`);
});

async function boot() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
  await migrate();
  await seed();
  // A redeploy or restart kills in-flight jobs; their advisory locks die with
  // the connection, so only the status row needs closing.
  await execute(
    "UPDATE job_runs SET status = 'error', error = 'interrupted by restart', finished_at = now() WHERE status = 'running'",
  );
  ready = true;
  console.log("[boot] ready", JSON.stringify(credentialStatus()));
  if (env.schedulerEnabled) {
    startScheduler();
    runJob("bootstrap", {}, "startup").catch((e) => console.error("[boot] bootstrap:", e?.message ?? e));
  } else {
    console.log("[boot] scheduler disabled (SCHEDULER=off)");
  }
}

boot().catch((e) => {
  bootError = String(e?.message ?? e);
  console.error("[boot] failed:", e);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  await stopScheduler().catch(() => {});
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
