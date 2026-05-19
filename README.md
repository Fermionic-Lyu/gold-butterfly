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

Forms a directional view from price action, skew, and flow, then picks
the structure that fits the current vol environment: long stock or long
options when vol is cheap, debit verticals when vol is fair, credit
spreads against the same direction when vol is rich. Sits out when
there's no clean trend.

Operates 21–60 DTE on stocks, calls, puts, and four vertical-spread
types (bull call / bear put debits, bull put / bear call credits). Caps
stock positions at 25% of starting capital, option positions at 12%, and
per-symbol concentration at 35%. Takes profits at 50%, manages losers at
21 DTE, needs ≥ 0.60 self-rated confidence to open a trade. Up to 6
concurrent positions.

### Theta · Sonnet — premium selling

**Model:** `anthropic/claude-sonnet-4.6` · **Focus:** mechanical premium
collection in the TastyTrade tradition

Sells rich implied volatility and lets time decay do the work. Strict
regime gate — only enters when IV/HV ≥ 1.10 *or* IV Rank ≥ 30. Short
legs sit at 16–25 delta on 25–50 DTE; defined-risk structures are
strongly preferred over naked premium.

Allowed structures: cash-secured puts, covered calls, bull-put and
bear-call credit spreads, iron condors. Sizes defined-loss positions at
≤ 20% of starting capital with ≤ 30% per-symbol concentration. Takes
profits at 50% of credit captured and manages at 21 DTE — the canonical
TastyTrade pattern. Needs ≥ 0.62 confidence. Up to 5 concurrent
positions.

### Vega · Gemini — long-vol contrarian

**Model:** `google/gemini-3.1-pro-preview` · **Focus:** buying cheap
vol before it expands

Hunts for under-priced movement. Only buys premium when IV/HV ≤ 0.95
*or* IV Rank ≤ 25 — refuses to pay up. Operates 30–90 DTE so vol has
room to expand and the thesis time to play out.

Allowed structures: long calls, long puts, long straddles, long
strangles, calendar spreads. Aggressively small sizing (≤ 8% of
starting capital per trade) because long premium decays. Cuts losers
at 50% of premium paid; takes profits at 75% gain *or* when IV pops
while the underlying stays flat. Needs ≥ 0.65 confidence. Up to 5
concurrent positions.

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

## Run your own copy

The app is designed to be cloned. You bring your own InsForge project,
your own market-data accounts, and you have a fully private instance you
can poke at, modify, and break without affecting anyone else.

### Step 1 — Accounts you'll need

All have free tiers that are enough to run the app end-to-end.

| Service | What it provides | Sign up |
|---|---|---|
| **InsForge** | The whole backend — Postgres, edge functions, storage, cron, auth — and a built-in OpenRouter key via Model Gateway | <https://insforge.dev> |
| **Alpaca** | Historical bars, option chains, US market calendar | <https://alpaca.markets> |
| **Finnhub** | Fundamentals (market cap, P/E) + earnings dates | <https://finnhub.io> |

Local prereq: **Node ≥ 22.12**.

### Step 2 — Create an InsForge project

1. Sign up at <https://insforge.dev>.
2. Create a new project from the dashboard. Pick any name and the closest
   region.
3. From the project's dashboard, grab the **Project URL** (looks like
   `https://<appkey>.<region>.insforge.app`) and the **anon key** — you'll
   use both in a minute.

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

### Step 6 — Set the backend secrets

These are credentials the edge functions use to call third-party APIs.
The CLI stores them server-side, separate from the frontend bundle.

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

### Step 7 — Apply the database schema

```sh
npx --yes @insforge/cli db migrations up
```

This runs the 37 migration files in `migrations/`.

### Step 8 — Bring everything else up

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

### Step 9 — Run it

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
