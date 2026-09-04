#!/usr/bin/env node
// One-shot InstaCloud provisioning + deploy.
//
//   npm run setup                 deploy the published image (ghcr.io/<owner>/<repo>:latest)
//   npm run setup -- --build      build + push that image with local Docker first
//   npm run setup -- --no-deploy  provision + secrets only; the compute service was
//                                 created from GitHub in the console and builds on push
//   IMAGE=<ref> npm run setup     deploy a specific image
//   COMPUTE=<name> npm run setup  pick the compute service when there are several
//
// Needs the `insta` CLI logged in (`insta login`). Creates the project if
// this directory isn't linked, adds a Postgres service and (if none exists) an
// always-on compute service, binds the database into it, stores the API keys
// as platform secrets, deploys, and waits for the app to report ready.
// Re-running is safe.
//
// Keys are read from the environment (ALPACA_API_KEY, ALPACA_API_SECRET,
// OPENROUTER_API_KEY, optional FINNHUB_API_KEY) or prompted for.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PORT = 8080;
const UPSTREAM_IMAGE = "ghcr.io/fermionic-lyu/gold-butterfly:latest";
const rl = createInterface({ input: stdin, output: stdout });

// ghcr.io/<owner>/<repo>:latest for this clone's origin, so a fork deploys the
// image its own Actions workflow publishes.
function defaultImage() {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const m = r.stdout?.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  return m ? `ghcr.io/${m[1].toLowerCase()}/${m[2].toLowerCase()}:latest` : UPSTREAM_IMAGE;
}

function insta(args, { inherit = false, allowFail = false } = {}) {
  const r = spawnSync("insta", args, {
    encoding: "utf8",
    stdio: inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (r.error) {
    if (r.error.code === "ENOENT") fail("`insta` CLI not found. Install: curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh");
    throw r.error;
  }
  if (r.status === 2) {
    fail(`InstaCloud needs an approval before continuing:\n${(r.stderr || r.stdout || "").trim()}\nRun the printed \`insta approvals approve <id>\` command, then re-run npm run setup.`);
  }
  if (r.status !== 0 && !allowFail) {
    fail(`insta ${args.join(" ")} failed:\n${(r.stderr || r.stdout || "").trim()}`);
  }
  return r;
}

const instaJson = (args) => JSON.parse(insta([...args, "--json"]).stdout);

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const ok = (msg) => console.log(`✓ ${msg}`);

async function ask(label, { optional = false } = {}) {
  const suffix = optional ? " (optional, Enter to skip): " : ": ";
  for (;;) {
    const v = (await rl.question(`${label}${suffix}`)).trim();
    if (v || optional) return v;
  }
}

async function main() {
  // 1. Login + link
  const status = instaJson(["status"]);
  if (!status.user) fail("Not logged in. Run `insta login` first, then re-run npm run setup.");
  ok(`logged in as ${status.user.email}`);

  if (!status.project) {
    const name = basename(process.cwd());
    console.log(`… creating project "${name}"`);
    insta(["project", "create", name], { inherit: true });
    ok(`project ${name} created and linked`);
  } else {
    ok(`linked to project ${status.project.projectId ?? status.project.id}`);
  }

  // 2. Services. Any existing compute service is the app — a GitHub-built one
  // created in the console keeps whatever name it was given.
  const services = instaJson(["services", "list"]);
  const list = Array.isArray(services) ? services : services?.services ?? [];
  const has = (type, name) => list.some((s) => s.type === type && s.name === name);
  if (!has("postgres", "db")) {
    insta(["services", "add", "postgres", "db"], { inherit: true });
    ok("postgres service `db` created");
  } else ok("postgres service `db` exists");
  const computes = list.filter((s) => s.type === "compute").map((s) => s.name);
  let compute = process.env.COMPUTE || computes[0] || null;
  if (compute && !computes.includes(compute)) fail(`no compute service named "${compute}" (have: ${computes.join(", ") || "none"})`);
  if (!compute) {
    // Always-on: the scheduler must keep running through idle nights/weekends.
    insta(["services", "add", "compute", "app", "--always-on", "--port", String(PORT)], { inherit: true });
    compute = "app";
    ok("compute service `app` created (always-on)");
  } else ok(`compute service \`${compute}\` exists${computes.length > 1 ? ` (others: ${computes.filter((c) => c !== compute).join(", ")}; set COMPUTE=<name> to pick)` : ""}`);

  // 3. Bind the database into the app
  insta(["secrets", "bind", "DATABASE_URL", "postgres/db", "--to", `compute/${compute}`]);
  ok(`DATABASE_URL bound into compute/${compute}`);

  // 4. Secrets
  const keys = [
    ["ALPACA_API_KEY", "Alpaca API key"],
    ["ALPACA_API_SECRET", "Alpaca API secret"],
    ["OPENROUTER_API_KEY", "OpenRouter API key"],
  ];
  for (const [name, label] of keys) {
    const value = process.env[name] || (await ask(label));
    insta(["secrets", "set", name, value]);
    ok(`${name} set`);
  }
  const finnhub = process.env.FINNHUB_API_KEY ?? (await ask("Finnhub API key", { optional: true }));
  if (finnhub) {
    insta(["secrets", "set", "FINNHUB_API_KEY", finnhub]);
    ok("FINNHUB_API_KEY set");
  }

  // 5. Headroom for the chain refresh (holds ~100K contract rows in memory).
  const limits = insta(["compute", "limits", compute, "--memory", "512mb"], { allowFail: true });
  if (limits.status === 0) ok("compute memory ceiling set to 512 MB");
  else console.log(`  (memory ceiling unchanged — paid plans can raise it with \`insta compute limits ${compute} --memory 512mb\`)`);
  insta(["compute", "always-on", "on", compute], { allowFail: true });

  // 6. Deploy. A compute service created from GitHub in the console builds and
  // deploys on every push, so --no-deploy stops here. Otherwise the CLI
  // deploys a prebuilt image: the insta-compute provider refuses
  // `insta deploy <dir>`, so the image comes from GHCR (published by the
  // GitHub Actions workflow on push to main) or a local Docker build (--build).
  let url = null;
  const image = process.env.IMAGE || defaultImage();
  if (process.argv.includes("--no-deploy")) {
    ok("skipping image deploy (the compute service builds from GitHub on push)");
    url = manifestUrl();
    if (!url) {
      console.log(`
Provisioned. Once the GitHub build finishes, find the URL with \`insta manifest\` and check
<url>/api/health. If the build ran before the secrets were set: insta compute restart ${compute}
`);
      return;
    }
  } else if (process.argv.includes("--build")) {
    console.log(`… building ${image} for linux/amd64 and pushing (needs Docker + registry login)`);
    // The source label links the GHCR package to the repo so it inherits the
    // repo's (public) visibility — InstaCloud pulls anonymously.
    const source = image.match(/^ghcr\.io\/([^/]+)\/([^/:]+)/);
    const labels = source ? ["--label", `org.opencontainers.image.source=https://github.com/${source[1]}/${source[2]}`] : [];
    const b = spawnSync(
      "docker",
      ["buildx", "build", "--platform", "linux/amd64", "-t", image, ...labels, "--push", "."],
      { stdio: "inherit" },
    );
    if (b.status !== 0) fail("docker build/push failed — is Docker running and are you logged in to the registry?");
    ok(`pushed ${image}`);
  }
  if (!process.argv.includes("--no-deploy")) {
    console.log(`… deploying ${image}`);
    const dep = spawnSync("insta", ["deploy", "--image", image, "--group", compute, "--port", String(PORT), "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (dep.status === 2) fail("Deploy needs an approval — run the printed `insta approvals approve <id>` and re-run npm run setup.");
    if (dep.status !== 0) {
      fail(
        `deploy failed (see output above). If the image could not be pulled, make sure it exists and is public:\n` +
          `  - push this repo to GitHub so .github/workflows/publish-image.yml publishes ${image}, or\n` +
          `  - run: npm run setup -- --build   (local Docker build + push)\n` +
          `  - or create the compute service from GitHub in the console and use: npm run setup -- --no-deploy`,
      );
    }
    try {
      url = JSON.parse(dep.stdout).url;
    } catch {
      // fall back to the manifest below
    }
    url ??= manifestUrl();
    if (!url) fail("deployed, but could not determine the app URL — run `insta manifest`.");
    ok(`deployed: ${url}`);
  }

  // 7. Verify the app actually serves and finished migrating
  console.log("… waiting for the app to come up");
  const deadline = Date.now() + 180_000;
  let health = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      health = await res.json().catch(() => null);
      if (res.ok && health?.ready) break;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!health?.ready) fail(`app did not report ready in time. Check: insta logs compute ${compute} --limit 100`);
  ok(`ready · credentials: ${Object.entries(health.credentials).map(([k, v]) => `${k}=${v ? "✓" : "✗"}`).join(" ")}`);

  console.log(`
Done. Open ${url} and create an account (the first account is the admin).

Market data backfills in the background for a few minutes on first boot.
Useful commands:
  insta logs compute ${compute} --limit 100                # server + job logs
  curl ${url}/api/jobs                                     # schedule + last runs
  insta compute exec ${compute} -- node /app/dist-server/cli.js run trading-tick '{"force":true,"dry_run":true}'
`);
}

// The compute service's public URL from the manifest, or null before the first deploy.
function manifestUrl() {
  try {
    const m = instaJson(["manifest"]);
    return JSON.stringify(m).match(/https:\/\/[a-z0-9.-]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

main()
  .catch((e) => fail(e?.message ?? String(e)))
  .finally(() => rl.close());
