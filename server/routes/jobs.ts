// Ops view over the scheduler. Reads are public (nothing sensitive in a job
// status); triggering a run needs the instance admin or a loopback caller
// (the in-container CLI).

import { Router } from "express";
import { isLoopback, optionalAuth } from "../auth.ts";
import { query, queryOne } from "../db.ts";
import { activeRuns, getJob, runJob, scheduleSummary } from "../jobs/index.ts";

export const jobsRouter = Router();

jobsRouter.get("/", async (_req, res) => {
  const last = await query(
    `SELECT DISTINCT ON (job) job, id, status, trigger, started_at, finished_at, error
       FROM job_runs ORDER BY job, started_at DESC`,
  );
  const byJob = new Map(last.map((r) => [r.job, r]));
  res.json({
    jobs: scheduleSummary().map((j) => ({ ...j, lastRun: byJob.get(j.name) ?? null })),
    active: activeRuns(),
  });
});

jobsRouter.get("/runs", async (req, res) => {
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 500);
  const job = typeof req.query.job === "string" && getJob(req.query.job) ? req.query.job : null;
  res.json(
    await query(
      `SELECT id, job, trigger, status, args, result, error, started_at, finished_at
         FROM job_runs WHERE $1::text IS NULL OR job = $1
        ORDER BY started_at DESC LIMIT $2`,
      [job, limit],
    ),
  );
});

jobsRouter.get("/runs/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "invalid id" });
  const row = await queryOne("SELECT * FROM job_runs WHERE id = $1", [id]);
  if (!row) return void res.status(404).json({ error: "not found" });
  res.json(row);
});

jobsRouter.post("/:name/run", optionalAuth, async (req, res) => {
  const name = String(req.params.name ?? "");
  if (!getJob(name)) return void res.status(404).json({ error: `unknown job: ${name}` });
  if (!(req.user?.isAdmin || isLoopback(req))) {
    return void res.status(403).json({ error: "admin session required" });
  }
  const args = req.body && typeof req.body === "object" ? req.body : {};
  const trigger = req.user ? `manual:${req.user.email}` : "manual:cli";
  if (req.query.wait === "1") {
    res.json(await runJob(name, args, trigger));
    return;
  }
  runJob(name, args, trigger).catch((e) => console.error(`[jobs] ${name}: ${e?.message ?? e}`));
  res.status(202).json({ accepted: true, job: name, poll: `/api/jobs/runs?job=${name}&limit=1` });
});
