# Gold Butterfly

An options-market intelligence app for traders who want a little help from
AI. Watch live option chains, greeks, IV history, and fundamentals — and let
language models help you reason about what to do with them.

The name comes from the **Iron Butterfly** option strategy: a four-leg
defined-risk structure that profits when the underlying stays close to the
short strikes. The "Gold" is just a wink — the app is a sandbox for
turning market structure into something useful, not a guarantee of riches.

**🦋 Live demo:** <https://gold-butterfly.insforge.site>

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
  history, upcoming earnings, fundamentals — all pulled directly from
  Alpaca and Finnhub on a cron.
- **Ask AI for a strategy.** From any symbol's dashboard, hand the regime
  snapshot to an LLM and get back three concrete trade proposals
  (structured legs, breakevens, POP estimate, management rules) grounded
  in widely-cited frameworks like TastyTrade and Sheldon Natenberg's
  *Option Volatility & Pricing*.
- **Run your own AI trading agents.** Create agents with custom prompts,
  model choice, watchlists, capital, and risk presets. Each one
  paper-trades the market once a day after the close, decides what to
  open / close / hold, and you watch how its philosophy plays out over
  weeks and months. Three default agents (`Delta · GPT`,
  `Theta · Sonnet`, `Vega · Gemini`) ship out of the box — directional
  momentum, premium selling, and long vol.

## Stack

- **Frontend:** Vite + React, deployed as a static site.
- **Backend:** [InsForge](https://insforge.dev) — Postgres, edge functions
  (Deno), storage, scheduled cron jobs, auth.
- **Market data:** [Alpaca](https://alpaca.markets) (bars, option chains,
  trading calendar) + [Finnhub](https://finnhub.io) (fundamentals,
  earnings).
- **LLMs:** [OpenRouter](https://openrouter.ai) (one key, every model).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Frontend (Vite + React)                                                │
│  src/  →  dashboard, agent pages, strategy panel                        │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │  reads / mutates via @insforge/sdk
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  InsForge backend                                                       │
│                                                                         │
│   Postgres tables ── chain_quotes, daily_bars, agents, positions, …     │
│        ▲                                                                │
│        │ written by                                                     │
│        │                                                                │
│   Edge functions (functions/*.ts, deployed to Deno runtime):            │
│     ├─ fetch-chains      ─┐                                             │
│     ├─ fetch-minute-bars  │  Alpaca   (intraday cron schedules)         │
│     ├─ fetch-daily-bars   │                                             │
│     ├─ snapshot-chain-eod │                                             │
│     ├─ fetch-earnings-dates ── Finnhub                                  │
│     ├─ fetch-fundamentals ──── Finnhub                                  │
│     ├─ sync-market-calendar ── Alpaca                                   │
│     ├─ backfill-minute-bars ── one-shot manual recovery                 │
│     ├─ trading-tick      ──── LLM via OpenRouter (post-close)           │
│     └─ strategy-analysis ──── LLM via OpenRouter (user-triggered)       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Run your own copy

The app is designed to be cloned. You bring your own InsForge project,
your own market-data accounts, your own LLM key, and you have a fully
private instance you can poke at, modify, and break without affecting
anyone else.

### Step 1 — Accounts you'll need

All have free tiers that are enough to run the app end-to-end.

| Service | What it provides | Sign up |
|---|---|---|
| **InsForge** | The whole backend — Postgres, edge functions, storage, cron, auth | <https://insforge.dev> |
| **Alpaca** | Historical bars, option chains, US market calendar | <https://alpaca.markets> |
| **Finnhub** | Fundamentals (market cap, P/E) + earnings dates | <https://finnhub.io> |
| **OpenRouter** | Single API key for every supported LLM | <https://openrouter.ai> |

Local prereq: **Node ≥ 22.12**.

### Step 2 — Create an InsForge project

1. Sign up at <https://insforge.dev>.
2. Create a new project from the dashboard. Pick any name and the closest
   region.
3. From the project's dashboard, grab the **Project URL** (looks like
   `https://<appkey>.<region>.insforge.app`) and the **anon key** — you'll
   need both in a minute.

### Step 3 — Clone and install

```sh
git clone https://github.com/<you>/gold-butterfly.git
cd gold-butterfly
npm install
```

### Step 4 — Configure the frontend env

```sh
cp .env.example .env
```

Open `.env` and fill in:

```env
VITE_INSFORGE_URL=https://<your-project>.us-east.insforge.app
VITE_INSFORGE_ANON_KEY=<your-anon-key>
```

Both come from your InsForge project dashboard. These are the *public*
keys baked into the frontend bundle.

### Step 5 — Link the InsForge CLI to your project

```sh
npx --yes @insforge/cli link
```

This walks you through authenticating, picking your project, and writes
`.insforge/project.json` locally (gitignored — contains a privileged
project API key). After this every `insforge …` command runs against
your project.

### Step 6 — Set the five backend secrets

These are credentials your edge functions use to call third-party APIs.
The CLI stores them server-side; they're never embedded in the frontend.

```sh
npx --yes @insforge/cli secrets add ALPACA_API_KEY     <your-alpaca-key>
npx --yes @insforge/cli secrets add ALPACA_API_SECRET  <your-alpaca-secret>
npx --yes @insforge/cli secrets add FINNHUB_API_KEY    <your-finnhub-key>
npx --yes @insforge/cli secrets add OPENROUTER_API_KEY <your-openrouter-key>
npx --yes @insforge/cli secrets add SCHEDULE_SECRET    "$(openssl rand -hex 32)"
```

(`SCHEDULE_SECRET` is generated locally — any high-entropy string works.
It's how the cron schedules authenticate to your edge functions.)

`.env.example` has more detail on each one — where to find it and what
the function uses it for.

### Step 7 — Apply the database schema

```sh
npx --yes @insforge/cli db migrations up
```

This runs all 37 migration files in `migrations/`. They contain *schema
only* — no reference data. Seeds come in the next step.

### Step 8 — Bring everything else up

```sh
npm run setup
```

One command, runs the script at [scripts/setup.mjs](scripts/setup.mjs).
It will:

1. Deploy all 10 edge functions from `functions/*.ts`.
2. Seed the `instruments` table from `data/instruments/{spx,ndx}.json`
   (~ 600 symbols across the S&P 500 and Nasdaq-100).
3. Seed the three default agents from `data/agents.json`.
4. Seed known US market holidays from `data/market-holidays.json`.
5. Create the `logos` storage bucket and upload the 100 NDX-100 company
   logos from `data/logos/`.
6. Patch `instruments.logo_url` so the frontend can resolve each logo.
7. Create the 10 cron schedules described in
   [schedules/schedules.mjs](schedules/schedules.mjs).

Every step is idempotent — if anything fails partway, fix the cause and
re-run.

### Step 9 — Run it

For local dev:

```sh
npm run dev
```

The dashboard opens at `http://localhost:5173`, talking to your live
InsForge project. Create an account (sign-up is exposed in-app), then
start exploring symbols and agents.

To deploy a production build:

```sh
npm run build
npm run deploy   # pushes the built bundle via the InsForge CLI
```

## Repository layout

```
gold-butterfly/
├── src/                  React + Vite frontend (components/, lib/)
├── functions/            10 Deno edge functions (one .ts per slug)
├── migrations/           37 SQL migrations — schema only, no seed data
├── data/                 Reference data loaded by `npm run setup`
│   ├── agents.json       3 default agents
│   ├── instruments/      SPX (503) + NDX (102) constituents
│   ├── market-holidays.json   US market closures 2026 – 2027
│   └── logos/            100 NDX-100 company logos (PNG)
├── schedules/
│   └── schedules.mjs     Manifest of 10 cron schedules (read by setup.mjs)
├── scripts/
│   └── setup.mjs         One-shot project bring-up
├── .env.example          Documents every secret the app uses
└── package.json
```

## Development scripts

```sh
npm run dev         # Vite dev server, hot reload
npm run typecheck   # tsc -b across the frontend
npm run lint        # ESLint
npm run build       # Production build → dist/
npm run preview     # Local preview of the production build
npm run deploy      # Push the built frontend to InsForge
```

When you change one edge function, redeploy just that one:

```sh
npx --yes @insforge/cli functions deploy <slug> --file functions/<slug>.ts
```

(`npm run setup` redeploys all of them and is also fine, just slower.)

## How the trading day flows

Once the cron schedules are running, a US trading day looks like this
(UTC times — see `schedules/schedules.mjs` for ET translations):

| When (UTC) | Job | What it does |
|-----------:|-----|---|
| 13:00 – 21:59, every minute | `fetch-minute-bars` | Latest 1-min OHLCV for every watched symbol |
| 13:00 – 21:59, every 2 min | `fetch-chains` | Full option chain refresh into `chain_quotes` / `chain_underlyings` |
| 22:00 | `fetch-daily-bars` | Daily bars + HV30 recompute |
| 22:05 | `snapshot-chain-eod` | Archive today's chain into `chain_*_history` |
| 22:10 | `trading-tick` | Walk every active agent, ask its LLM what to do, apply decisions |
| 22:50 | `trading-tick` (retry) | Idempotency-safe rerun for any agent the primary tick failed on |
| 23:00 | `fetch-earnings-dates` | Refresh upcoming earnings from Finnhub |
| 02:00 | `fetch-fundamentals` | Refresh market cap + P/E from Finnhub |
| Mon 08:00 | `sync-market-calendar` | Pull next ~year of trading days / holidays from Alpaca |

The intraday data jobs all gate internally on `isMarketOpen()` and return
in ~600 ms outside market hours, so the wider-than-strict UTC windows are
cheap no-ops, not redundant work.

## Architectural notes

A few things to know before you start hacking on the internals.

- **Migrations are schema-only.** All seed data (instruments, agents,
  holidays) lives as JSON in `data/` and is loaded by `npm run setup`.
  This way you can refresh the seed set without inventing a new
  migration.
- **Functions are flat files**, not subdirectories. The InsForge CLI's
  default lookup is `insforge/functions/<slug>/index.ts`, so every deploy
  here passes `--file functions/<slug>.ts` explicitly. The setup script
  handles this for you.
- **`trading-tick` and `strategy-analysis` call OpenRouter directly**,
  not through any wrapped AI gateway, so model choice and rate-limit
  behavior are entirely under your control. The schedule-driven path
  (`trading-tick`) is gated by a shared `X-Schedule-Secret`; the
  user-triggered path (`strategy-analysis`) verifies the caller is a
  signed-in user via `/api/auth/sessions/current`.
- **Logos cover NDX-100 only.** `data/logos/` ships the ~ 100 Nasdaq-100
  PNGs. The ~ 400 SPX-only symbols have `logo_url: null` in the seed and
  render without a logo on the dashboard until you backfill them.

## Contributing & forking

Contributions are very welcome — issues, PRs, comments on the
methodology, new agent presets, dashboard tweaks, anything. If you spot
something off about the trading mechanics or the cron timing, please
open an issue.

And please feel free to **fork this and make it yours.** The trading
methodology is opinionated; the data pipeline is reusable. You could
just as easily turn it into a **Silver Butterfly** that focuses on a
different set of underlyings, a **Diamond Butterfly** that ranks agents
differently, or a **Ruby Dragonfly** that abandons the option metaphor
entirely. Different watchlist, different model, different prompt,
different ranking heuristic — the architecture doesn't care.

## License

MIT — see [LICENSE](LICENSE).
