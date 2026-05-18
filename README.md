# gold-butterfly

A self-hosted paper-trading platform for **options-strategy agents** powered by
large language models. Each agent has its own option-trading philosophy
(directional momentum, premium selling, long-vol, …) and once per US trading
day it looks at the closing market state and decides what to do with its
paper portfolio.

The frontend is a Vite + React dashboard for inspecting the agents, the option
chains they're watching, and the trades they've made. The backend is a set of
InsForge edge functions on a Postgres database — one cron-driven function per
data source (minute bars, daily bars, chain refresh, etc.) plus one
LLM-driven function that runs the agents after the close.

> **Not financial advice.** This is a sandbox for studying how LLMs handle
> structured option-trading decisions. No real orders are placed.

## How it fits together

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

## Prerequisites

You'll need accounts at:

- **[InsForge](https://insforge.dev)** — backend host (Postgres, edge
  functions, storage, schedules, frontend deploy).
- **[Alpaca Markets](https://alpaca.markets)** — historical bars, option
  chains, market calendar. Paper-trading tier is fine.
- **[Finnhub](https://finnhub.io)** — fundamentals (market cap, P/E) and
  earnings dates. Free tier works (60 calls/min).
- **[OpenRouter](https://openrouter.ai)** — LLM gateway. The default agents
  use models from OpenAI, Anthropic, and Google through a single key.

And locally:

- **Node ≥ 22.12** (matches `engines` in [package.json](package.json)).

## Bringing up a fresh project

Run these once on a new InsForge project:

```sh
# 1. Clone and install
git clone <your-fork-url> gold-butterfly
cd gold-butterfly
npm install

# 2. Frontend env (the Vite app reads these at build time)
cp .env.example .env
# Edit .env: fill in VITE_INSFORGE_URL and VITE_INSFORGE_ANON_KEY from the
# InsForge dashboard for your project.

# 3. Link this checkout to an InsForge project
#    Creates .insforge/project.json (gitignored — contains a project api_key)
npx --yes @insforge/cli link

# 4. Set the 5 user-managed backend secrets. See .env.example for what each
#    one is and where to obtain it.
npx --yes @insforge/cli secrets add ALPACA_API_KEY     <value>
npx --yes @insforge/cli secrets add ALPACA_API_SECRET  <value>
npx --yes @insforge/cli secrets add FINNHUB_API_KEY    <value>
npx --yes @insforge/cli secrets add OPENROUTER_API_KEY <value>
npx --yes @insforge/cli secrets add SCHEDULE_SECRET    "$(openssl rand -hex 32)"

# 5. Apply the schema (37 migrations — DDL only, no seed data)
npx --yes @insforge/cli db migrations up

# 6. Deploy edge functions, seed reference data, upload logos, create
#    schedules. All idempotent — safe to re-run if any step fails.
npm run setup
```

When step 6 completes you should see all 10 functions in
`insforge functions list`, the 3 default agents in `insforge db query …`,
and 10 active rows in `insforge schedules list`.

## What `npm run setup` does

[scripts/setup.mjs](scripts/setup.mjs) does everything that can't live in a
SQL migration:

1. **Deploys all 10 edge functions** from `functions/*.ts` via the InsForge
   CLI. Each function is a single Deno file.
2. **Seeds reference data** from `data/`:
   - `data/instruments/spx.json` + `data/instruments/ndx.json` →
     `instruments` table (S&P 500 ∪ Nasdaq-100, ~ 600 symbols).
   - `data/agents.json` → 3 system-owned default agents.
   - `data/market-holidays.json` → known US market holidays for 2026–2027.
3. **Creates the `logos` storage bucket**, uploads each PNG from
   `data/logos/`, and patches `instruments.logo_url` so the frontend can
   render each company logo.
4. **Creates the 10 cron schedules** described in
   [schedules/schedules.mjs](schedules/schedules.mjs) (the file's header
   explains why the intraday cron windows are wider than strict market
   hours — DST handling).

## Repository layout

```
gold-butterfly/
├── src/                  React + Vite frontend (components/, lib/)
├── functions/            10 Deno edge functions (one .ts per slug)
├── migrations/           37 SQL migrations (schema only — no seed data)
├── data/                 Seed data loaded by `npm run setup`
│   ├── agents.json       3 default agents (one per option-strategy style)
│   ├── instruments/      SPX (503) + NDX (102) constituents
│   ├── market-holidays.json   US market closures 2026 – 2027
│   └── logos/            100 NDX-100 company logos (PNG)
├── schedules/
│   └── schedules.mjs     Manifest of 10 cron schedules (read by setup.mjs)
├── scripts/
│   └── setup.mjs         One-shot bring-up (function deploy + seed + schedules)
├── .env.example          Documents frontend (Vite) and backend (platform) secrets
└── package.json          Standard Vite/React app + setup/deploy scripts
```

## Development

```sh
npm run dev         # Vite dev server, hot-reload
npm run typecheck   # tsc -b across the frontend
npm run lint        # ESLint (pre-existing `any` warnings — see Known issues)
npm run build       # Production build → dist/
npm run preview     # Local preview of the production build
npm run deploy      # Push the built frontend to InsForge / Vercel
```

When changing an edge function locally, redeploy it with:

```sh
npx --yes @insforge/cli functions deploy <slug> --file functions/<slug>.ts
```

(`npm run setup` will also redeploy all of them, which is fine but slower
than targeting one.)

## How the trading-day loop works

Once the cron schedules are running, the daily lifecycle on a US trading day
looks like this (times below are UTC; see `schedules/schedules.mjs` for the
ET translations):

| When (UTC) | Job | What it does |
|-----------:|-----|---|
| 13:00 – 21:59 every min | `fetch-minute-bars` | Latest 1-min OHLCV for every watched symbol |
| 13:00 – 21:59 every 2 min | `fetch-chains` | Full option chain refresh into `chain_quotes` / `chain_underlyings` |
| 22:00 | `fetch-daily-bars` | Daily bars + HV30 recompute |
| 22:05 | `snapshot-chain-eod` | RPC archives today's chain into `chain_*_history` |
| 22:10 | `trading-tick` | Reads every active agent's state, asks its configured LLM what to do, applies the decisions |
| 22:50 | `trading-tick` (retry) | Same function, idempotency-safe rerun for any agent the primary tick failed on |
| 23:00 | `fetch-earnings-dates` | Refresh upcoming-earnings calendar from Finnhub |
| 02:00 | `fetch-fundamentals` | Refresh market cap + P/E from Finnhub |
| Mon 08:00 | `sync-market-calendar` | Pull next ~year of trading days / holidays from Alpaca |

The intraday data-fetch functions all internally gate on `isMarketOpen()`
and return in ~600 ms outside market hours, so the wider-than-needed UTC
windows are cheap no-ops, not redundant work.

## Architectural notes

- **Migrations contain schema only.** All seed data (instruments, agents,
  holidays) lives as JSON in `data/` and is loaded by `npm run setup`. This
  keeps DDL and reference data on separate axes — easier to refresh seeds
  without inventing a new migration.
- **Functions are flat files**, not subdirectories. The InsForge CLI's
  default lookup is `insforge/functions/<slug>/index.ts`, so every deploy
  here passes `--file functions/<slug>.ts` explicitly. The setup script
  handles this for you.
- **`trading-tick` and `strategy-analysis` call OpenRouter directly**, not
  through any InsForge SDK AI wrapper, so model choice and rate-limit
  behavior are entirely under your control. The schedule-driven path
  (`trading-tick`) is gated by a shared `X-Schedule-Secret`; the
  user-triggered path (`strategy-analysis`) verifies the caller is a
  signed-in user via `/api/auth/sessions/current`.
- **Logo coverage is NDX-only**. The `data/logos/` directory ships the
  ~100 Nasdaq-100 logos. The ~400 SPX-only symbols have `logo_url: null`
  in the seed and render without a logo on the dashboard until you
  backfill them.

## License

MIT — see [LICENSE](LICENSE).
