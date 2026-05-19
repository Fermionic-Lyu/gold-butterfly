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
  model choice, watchlists, capital, and risk presets. Each agent
  evaluates its watchlist **once per US trading day, shortly after the
  4:00 PM ET close**, using the closing snapshot of bars and option
  chains to decide what to open, close, or hold. Fills and mark-to-market
  P&L are calculated off those same closing prices, so what an agent
  "sees" and what it "trades at" are always consistent. Three default
  agents ship out of the box, profiled below.

## Default agents

The seed data ships three agents, each pinned to a different model
provider and a different option-trading philosophy. All three run on the
same cadence — the cron fires shortly after the 4:00 PM ET close, the
LLM sees the closing-snapshot option chain plus the day's bars and its
own portfolio state, and any open / close decisions are filled at those
closing prices. They share the same $100,000 paper-trading capital but
follow very different rules — running them side-by-side makes the
regime dependence of each strategy obvious within a few weeks of live
market data.

### Delta · GPT — directional momentum

**Model:** `openai/gpt-5.4` · **Focus:** trend-following

### Theta · Sonnet — premium selling

**Model:** `anthropic/claude-sonnet-4.6` · **Focus:** mechanical premium collection (TastyTrade-style)

### Vega · Gemini — long-vol contrarian

**Model:** `google/gemini-3.1-pro-preview` · **Focus:** buying cheap vol before it expands

## Stack

The frontend is **Vite + React**, deployed as a static site. The backend
is **[InsForge](https://insforge.dev)** — Postgres, Deno edge functions,
scheduled cron, storage, and auth all on one platform.

Market and LLM data flows in through three external services, each called
from a scheduled edge function:

- **[Alpaca](https://alpaca.markets)** — historical bars, option chains,
  and the US trading calendar.
- **[Finnhub](https://finnhub.io)** — company fundamentals (market cap,
  P/E) and the earnings calendar.
- **[OpenRouter](https://openrouter.ai)** — single API gateway to every
  major LLM provider, used by the strategy analyzer and the trading
  agents.

The cron jobs (declared in [schedules/schedules.mjs](schedules/schedules.mjs))
follow the US trading day:

- **Every minute** during market hours, the latest 1-min bars for every
  watched symbol land in the database.
- **Every 2 minutes** during market hours, the full option chain refreshes
  into normalized `chain_quotes` / `chain_underlyings` tables.
- **After the close**, daily OHLCV + HV30 recompute, then an EOD chain
  snapshot is archived, then every active agent is walked through its
  LLM, which decides what to do; a retry-backstop runs 40 min later for
  any agent the primary tick missed.
- **Nightly**, fundamentals and the upcoming-earnings calendar refresh
  from Finnhub.
- **Weekly**, the trading calendar pulls the next year of trading days
  and known closures from Alpaca.

### Data freshness

Out of the box, on the free Alpaca tier and a small InsForge instance,
that schedule gives you **1-minute bars and 2-minute chain refresh during
market hours** across the Nasdaq-100 universe — plenty for studying
intraday regime and running daily-cadence agents. For tighter intervals
(sub-second chain refresh, second-level bars), wider symbol coverage, or
heavier LLM throughput, a paid Alpaca plan plus a larger InsForge
instance unlock the headroom — the same edge functions just run on a
denser schedule.

## Accounts you'll need

The app is designed to be cloned. You bring your own InsForge project,
your own market-data accounts, and you have a fully private instance you
can poke at, modify, and break without affecting anyone else. All three
services below have free tiers that are enough to run the app end-to-end.

| Service | What it provides | Sign up |
|---|---|---|
| **InsForge** | The whole backend — Postgres, edge functions, storage, cron, auth — and a built-in OpenRouter key via Model Gateway | <https://insforge.dev> |
| **Alpaca** | Historical bars, option chains, US market calendar | <https://alpaca.markets> |
| **Finnhub** | Fundamentals (market cap, P/E) + earnings dates | <https://finnhub.io> |

After signing up at InsForge, create a new project (any name, closest
region) and grab two values from its dashboard — you'll need them in a
minute:

- **Project URL** — looks like `https://<appkey>.<region>.insforge.app`
- **anon key** — the public client key

Local prereq: **Node ≥ 22.12**.

## Setup with a coding agent

If you use a coding agent that can run shell commands (Claude Code,
Cursor, Aider, Codex CLI, …), clone the repo, `cd` into it, and paste the
prompt below. The agent will ask for any credentials it needs, run every
command, and verify each step.

````
I just cloned the Gold Butterfly repo — an options-market sandbox built
on InsForge. I'm in the project root. Walk me through the full setup on
my InsForge project: ask me for any keys you need, run the commands
yourself, and verify each step before moving to the next. Don't skip
steps. If anything errors, diagnose the cause and fix it before going on.

Prerequisites I've already handled:
- Created an InsForge project at https://insforge.dev. I have its
  Project URL (like https://<appkey>.us-east.insforge.app) and anon key.
- Created accounts at Alpaca Markets and Finnhub. I have the API keys.
- Located my OpenRouter key — either in the InsForge dashboard under
  "Model Gateway", or from my own OpenRouter account.

Steps:

1. Run `npm install`.

2. Copy `.env.example` to `.env`. Ask me for VITE_INSFORGE_URL and
   VITE_INSFORGE_ANON_KEY, then write them into `.env`.

3. Run `npx --yes @insforge/cli link` and walk me through any interactive
   prompts. This writes .insforge/project.json (gitignored).

4. Ask me for each of these credentials, then set them as InsForge
   secrets with `npx --yes @insforge/cli secrets add <KEY> <VALUE>`:
     - ALPACA_API_KEY
     - ALPACA_API_SECRET
     - FINNHUB_API_KEY
     - OPENROUTER_API_KEY
   Then generate SCHEDULE_SECRET yourself with `openssl rand -hex 32`
   and set it the same way (no need to ask me — it's just a random
   high-entropy string).

5. Apply the schema: `npx --yes @insforge/cli db migrations up`.

6. Run `npm run setup`. This deploys all 10 edge functions, seeds
   reference data, uploads logos, and creates the cron schedules.
   Idempotent — safe to re-run.

7. Verify:
     npx --yes @insforge/cli functions list    # expect 10 functions
     npx --yes @insforge/cli schedules list    # expect 10 schedules

8. Tell me to run `npm run dev`, open http://localhost:5173, sign up
   in the app, and report back if anything looks off.
````

## Set it up step by step

If you'd rather drive each step yourself:

### 1. Clone and install

```sh
git clone https://github.com/<you>/gold-butterfly.git
cd gold-butterfly
npm install
```

### 2. Configure the frontend env

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

### 3. Link the InsForge CLI to your project

```sh
npx --yes @insforge/cli link
```

Walks you through authenticating, picking your project, and writes
`.insforge/project.json` locally (gitignored — contains a privileged
project API key). After this, every `insforge …` command runs against
your project.

### 4. Set the backend secrets

Credentials the edge functions use to call third-party APIs. The CLI
stores them server-side, separate from the frontend bundle.

```sh
npx --yes @insforge/cli secrets add ALPACA_API_KEY     <your-alpaca-key>
npx --yes @insforge/cli secrets add ALPACA_API_SECRET  <your-alpaca-secret>
npx --yes @insforge/cli secrets add FINNHUB_API_KEY    <your-finnhub-key>
npx --yes @insforge/cli secrets add SCHEDULE_SECRET    "$(openssl rand -hex 32)"
```

For the LLM key:

```sh
# OPENROUTER_API_KEY — InsForge provisions one for you out of the box.
# Find it in your InsForge dashboard → Model Gateway and add it as the
# secret below. (Prefer your own OpenRouter account? Use that key instead;
# everything still works the same way.)
npx --yes @insforge/cli secrets add OPENROUTER_API_KEY <key-from-dashboard>
```

`SCHEDULE_SECRET` is generated locally — any high-entropy string works.
It's how the cron schedules authenticate to the edge functions. See
`.env.example` for where each external key comes from.

### 5. Apply the database schema

```sh
npx --yes @insforge/cli db migrations up
```

Runs the 37 migration files in `migrations/`.

### 6. Bring everything else up

```sh
npm run setup
```

One command, idempotent. It:

- Deploys all 10 edge functions from `functions/*.ts`
- Seeds the reference data: the Nasdaq-100 instrument universe (~100
  symbols), the three default agents, and US market holidays for 2026–2027
- Creates the `logos` storage bucket and uploads the 100 NDX-100 logos
- Creates the 10 cron schedules listed in
  [schedules/schedules.mjs](schedules/schedules.mjs)

### 7. Run it

For local dev:

```sh
npm run dev
```

The dashboard opens at `http://localhost:5173`, talking to your live
InsForge project. Create an account in-app, then start exploring symbols
and agents.

To deploy a production build:

```sh
npm run build
npm run deploy   # pushes the built bundle via the InsForge CLI
```

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
