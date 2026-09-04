# Gold Butterfly

An options-market intelligence app for traders who want a little help from
AI. Watch live option chains, greeks, IV history, and fundamentals — and let
language models help you reason about what to do with them.

The name comes from the **Iron Butterfly** option strategy: a four-leg
defined-risk structure that profits when the underlying stays close to the
short strikes. The "Gold" is just a wink — the app is a sandbox for
turning market structure into something useful, not a guarantee of riches.

> ### ⚠️ Educational and research use only — not financial advice
>
> Gold Butterfly is a sandbox for studying how language models reason about
> options strategies. Everything here is **paper trading only** — no real
> orders are placed, and no brokerage integration is wired up.
>
> AI strategy proposals and agent decisions can be wrong, hallucinated, or
> wildly off-base. Market data may be stale, delayed, or incorrect. Greeks
> and IV calculations are approximations, not the kind of figures a real
> trader would price off of.
>
> **Do not use this app, its outputs, or anything in this repository as the
> basis for an actual investment decision.** You are solely responsible for
> what you do with the code, the data, or any ideas it generates. The
> authors and contributors disclaim all liability for losses incurred from
> use or misuse of this software.

## What it does

- **Monitor the options market.** Real-time chains, full greek surface,
  implied vs. realized vol, term structure, skew, daily and minute price
  history, upcoming earnings, fundamentals — pulled from Alpaca (and
  optionally Finnhub) on a schedule.
- **Ask AI for a strategy.** From any symbol's dashboard, hand the regime
  snapshot to an LLM and get back three concrete trade proposals
  (structured legs, breakevens, POP estimate, management rules) grounded
  in widely-cited frameworks like TastyTrade and Sheldon Natenberg's
  *Option Volatility & Pricing*.
- **Run your own AI trading agents.** Create agents with custom prompts,
  model choice, watchlists, capital, and risk presets. Each agent
  evaluates its watchlist **once per US trading day, shortly after the
  4:00 PM ET close**, using the closing snapshot of bars and option
  chains — plus that day's AI news digest for each watched symbol — to
  decide what to open, close, or hold. Fills and mark-to-market P&L are
  calculated off those same closing prices. Three default agents ship out
  of the box, profiled below.
- **Read the daily news, digested.** Every morning the app scrapes
  headlines for every tracked symbol from free sources (Alpaca News, Yahoo
  Finance, Google News, and Finnhub when configured), then runs an LLM over
  each subscribed symbol's articles to produce a sentiment read, summary,
  and **options-relevant impact**, shown on the **News** tab.

## Default agents

The seed data ships three agents, each pinned to a different model
provider and a different option-trading philosophy. All three run on the
same cadence — shortly after the 4:00 PM ET close, the LLM sees the
closing-snapshot option chain plus the day's bars, the news digest, and
its own portfolio state, and any open / close decisions are filled at
those closing prices. They share the same $100,000 paper-trading capital
but follow very different rules.

### Delta · GPT — directional momentum

**Model:** `openai/gpt-5.4` · **Focus:** trend-following

### Theta · Sonnet — premium selling

**Model:** `anthropic/claude-sonnet-4.6` · **Focus:** mechanical premium collection (TastyTrade-style)

### Vega · Gemini — long-vol contrarian

**Model:** `google/gemini-3.1-pro-preview` · **Focus:** buying cheap vol before it expands

## Stack

One container on **[InstaCloud](https://instacloud.com)**:

- **Vite + React** frontend, served as static files by the same process.
- **Node + Express** API with cookie-session auth (email + password; the
  first account created becomes the instance admin).
- **Postgres** on InstaCloud — plain SQL, migrations in
  [migrations/](migrations/), applied automatically at boot.
- **In-process scheduler** (node-cron, America/New_York) running every
  data job — no external cron, no edge functions, no second platform.

External services, all called from the scheduled jobs:

- **[Alpaca](https://alpaca.markets)** — historical bars, option chains,
  the US trading calendar, and news. **Required.**
- **[OpenRouter](https://openrouter.ai)** — single API gateway to every
  LLM provider, used by the strategy analyzer, the news digest, and the
  trading agents. **Required.**
- **[Finnhub](https://finnhub.io)** — market cap, P/E, and earnings dates.
  **Optional**: without it those cards show the seeded values and earnings
  markers are omitted.

### Schedule (America/New_York)

| Job | When | What |
|---|---|---|
| `fetch-minute-bars` | every minute, 09:00–16:59 Mon–Fri | 1-min bars for the Nasdaq-100 (gated to the 09:30–16:00 session) |
| `fetch-chains` | every 2 min, same window | full option chains → `chain_quotes`; ATM IV sample on the half-hour |
| `fetch-daily-bars` | 18:00 Mon–Fri | daily OHLCV + HV30 recompute |
| `snapshot-chain-eod` | 18:05 Mon–Fri | archive the closing chain |
| `trading-tick` | 18:10 Mon–Fri (+ 18:50 backstop) | every active agent's daily decision |
| `fetch-earnings-dates` | 19:00 daily | Finnhub earnings calendar (skipped without a key) |
| `fetch-fundamentals` | 22:00 daily | Finnhub market cap / P/E (skipped without a key) |
| `scrape-news` → `analyze-news` | 04:30 daily (+ 05:30 backstop) | headlines for every symbol, AI digest for subscribed ones |
| `sync-market-calendar` | 04:00 Mondays | holidays and half-days from Alpaca |

On first boot (and whenever tables are still empty) a `bootstrap` job
backfills a year of daily bars, the current chain, the calendar, and the
day's headlines, so a fresh deploy is useful within minutes. Every run is
recorded in `job_runs`; `GET /api/jobs` shows the schedule and last status.

## Deploy to InstaCloud

You need three things: an [InstaCloud](https://instacloud.com) account,
an **Alpaca** API key + secret, and an **OpenRouter** API key. Everything
else (database, session secret, schedules) is created for you.

```sh
git clone https://github.com/<you>/gold-butterfly.git
cd gold-butterfly
npm install
insta login          # once; opens the browser
npm run setup        # prompts for the keys, provisions, deploys, verifies
```

`npm run setup` runs the equivalent of:

```sh
insta project create gold-butterfly
insta services add postgres db
insta services add compute app --always-on --port 8080
insta secrets bind DATABASE_URL postgres/db --to compute/app
insta secrets set ALPACA_API_KEY <key>
insta secrets set ALPACA_API_SECRET <secret>
insta secrets set OPENROUTER_API_KEY <key>
insta deploy --image ghcr.io/<owner>/gold-butterfly:latest --port 8080
```

then polls `/api/health` until the app reports `ready`. Open the printed
URL, create an account, and start exploring. Market data backfills in the
background for a few minutes.

Optional afterwards: `insta secrets set FINNHUB_API_KEY <key>` followed by
`insta compute restart app` turns on fundamentals and earnings dates.

> The compute service is **always-on** on purpose: the scheduler lives in the
> app process, and a scaled-to-zero machine would sleep through the cron
> windows. The database can stay on the default scale-to-zero setting.

### How the build gets to InstaCloud

InstaCloud's `insta-compute` provider builds from source only for a GitHub
repository connected in the console; the CLI's `insta deploy <dir>` upload
path is refused on it. Two ways to ship, pick one:

- **Build from GitHub (no registry involved).** Push the code to GitHub.
  In the InstaCloud console, add a **compute service from GitHub** to the
  project: pick the repository and branch, keep the [Dockerfile](Dockerfile)
  build, port `8080`. The console cannot attach a repo to an existing
  compute service, so the GitHub-built one becomes the app; delete any
  empty placeholder (`insta services remove compute <name>`). Then run
  `npm run setup -- --no-deploy`: it adds the database if needed, binds
  `DATABASE_URL` into that service, turns always-on on, and stores your
  keys. Every later push rebuilds and redeploys.
- **Ship a prebuilt image.**
  [`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml)
  publishes `ghcr.io/<owner>/<repo>:latest` on every push to `main` — a fork
  publishes to its own GHCR namespace, and `npm run setup` derives the image
  name from your `origin` remote. The loop is: push to `main`, wait for the
  workflow, run `npm run setup` (or `insta deploy --image … --port 8080` to
  redeploy). Without GitHub Actions, `npm run setup -- --build` builds the
  image locally with Docker (`linux/amd64`) and pushes it first; you need
  Docker running and `docker login ghcr.io`, or set
  `IMAGE=<registry/path:tag>` for any registry InstaCloud can pull from.

### Setup with a coding agent

If you use a coding agent that can run shell commands, clone the repo,
`cd` into it, and paste:

````
I just cloned the Gold Butterfly repo — an options-market sandbox that
deploys to InstaCloud. I'm in the project root. Run `npm install`, make
sure I'm logged in with `insta login`, then run `npm run setup` and give
it my Alpaca key/secret and OpenRouter key when it asks. Verify the
printed URL serves and /api/health reports ready. If anything errors,
diagnose and fix it before going on.
````

## Operating it

```sh
insta logs compute app --limit 100        # server + job logs
insta events --limit 30                   # deploys, approvals, resource changes
curl https://<app>/api/health             # readiness + which credentials are set
curl https://<app>/api/jobs               # schedule + last run per job
curl 'https://<app>/api/jobs/runs?limit=20'
```

Trigger a job by hand from inside the container (runs in the server
process, under the same lock and logging as scheduled runs):

```sh
insta compute exec app -- node dist-server/cli.js run fetch-chains '{"force":true}'
insta compute exec app -- node dist-server/cli.js run trading-tick '{"force":true,"dry_run":true}'
insta compute exec app -- node dist-server/cli.js run scrape-news
```

The instance admin (first account) can also `POST /api/jobs/<name>/run`
from a signed-in browser session.

## Local development

```sh
cp .env.example .env               # fill in the three keys
DATABASE_URL="$(insta db url)" npm run dev:server   # API on :8080, cron on
npm run dev                         # Vite on :5173, proxies /api → :8080
```

Set `SCHEDULER=off` when running locally against a database that a
deployed instance is already feeding, so two schedulers don't fire the
same jobs. `npm run job -- fetch-chains '{"force":true}'` triggers a job
on the local server.

Build and typecheck:

```sh
npm run typecheck && npm run lint && npm run build
```

## Layout

```
server/            Express API, scheduler, jobs
  index.ts         boot: listen → migrate → seed → cron → bootstrap
  routes/          auth, market data, agents, subscriptions, strategy, jobs
  jobs/            one file per scheduled job + shared Alpaca/LLM helpers
  cli.ts           in-container job trigger / migrate / seed
migrations/        plain SQL, applied in order at boot
data/              seed data: NDX-100 universe, default agents, holidays
src/               Vite + React frontend
public/logos/      instrument logos, served statically
scripts/           npm run setup (InstaCloud provisioning)
Dockerfile         multi-stage build; runtime image runs dist-server/index.js
```

## Contributing & forking

Contributions are very welcome — issues, PRs, comments on the
methodology, new agent presets, dashboard tweaks, anything. If you spot
something off about the trading mechanics or the cron timing, please
open an issue.

And please feel free to **fork this and make it yours.** The trading
methodology is opinionated; the data pipeline is reusable. Different
watchlist, different model, different prompt, different ranking
heuristic — the architecture doesn't care.

## License

MIT — see [LICENSE](LICENSE).
