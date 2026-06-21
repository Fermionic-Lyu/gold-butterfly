# Trading agents on Modal

The daily trading-agent runner lives here, ported from the `trading-tick`
InsForge edge function to [Modal](https://modal.com). It's the second (and
larger) piece of compute moved off InsForge — see [README.md](README.md) for
the news scraper.

## Why it moved

The edge function ran agents **strictly sequentially** (`BATCH_CONCURRENCY = 1`)
because a Deno edge function can't safely parallelize *3 agents × N symbols × an
LLM call each* inside its execution/HTTP window — it would time out or trip
`ECONNRESET` bursts. Modal removes that ceiling:

- **`run_agent.map(agents)`** — one container per agent, all in parallel.
- Inside each agent, **Phase A** fans its watched symbols across a thread pool.

So peak concurrency is now "every agent at once," not one-at-a-time.

## What did NOT move (stays in Postgres)

The transactional core is untouched and platform-agnostic:

- **`apply_agent_tick(payload)`** — one atomic transaction applying expirations,
  MTM, closes, opens, decisions, cash, and the equity snapshot.
- **The lease** (`agent_tick_applied`, `ON CONFLICT DO NOTHING`) — exactly-once
  application per `(agent, run_date)`, no matter how many times it's called.
- `decisions` unique index, `agent_runs` status table.

Modal computes the payload and calls the RPC over REST — exactly as the edge
function did. The lease is what made the cutover safe: while both the edge cron
and the Modal cron briefly coexisted, any double-fire was a no-op skip.

## Layout

```
modal/trading_app.py        Modal app: run_agent (fan-out worker) + coordinator
                            + tick_primary/tick_backstop crons + manual tick
modal/trading/
  util.py        numeric coercion, ET date, DTE math, OCC parsing
  pricing.py     multipliers, leg/position valuation, MTM, HV30, selection
  snapshot.py    per-symbol regime snapshot for the LLM
  validation.py  collateral math + order-independent pre-validation
  decision.py    LLM decision schema, prompt builder, JSON extraction
  db.py          InsForge REST/RPC (with retry on transient errors)
  market.py      Alpaca spot/chain/HV30 + cached-chain path
  agent.py       analyze_symbol (Phase A) + process_agent (Phase B)
  coordinator.py trading-day gate + idempotent agent-selection (pure)
```

It's a faithful port of `functions/trading-tick.ts` split into modules; the only
behavioral change is real parallelism (and a transient-retry on DB reads, which
matters more now that agents hit InsForge concurrently).

## Secrets

Reuses the `gold-butterfly` Modal secret (shared with the news scraper),
extended with the trading keys:

```sh
modal secret create gold-butterfly --force \
  INSFORGE_BASE_URL=...  INSFORGE_API_KEY=<service key> \
  FINNHUB_API_KEY=...    SCHEDULE_SECRET=... \
  ALPACA_API_KEY=...     ALPACA_API_SECRET=... \
  OPENROUTER_API_KEY=...
```

`INSFORGE_API_KEY` must be the privileged project/service key — it calls
`apply_agent_tick` and reads all active agents.

## Run it

```sh
modal deploy modal/trading_app.py                  # register the daily crons
modal run    modal/trading_app.py --dry-run --force  # compute payloads, apply nothing
modal run    modal/trading_app.py --force            # real run now (bypass day gate)
modal run    modal/trading_app.py --only-slug theta-sonnet --dry-run  # one agent
```

`--dry-run` runs Phase A + Phase B end-to-end (including live LLM calls) but
skips the `apply_agent_tick` write and the `agent_runs` status updates — use it
to eyeball decisions before they hit the books.

## Cron & cutover

Schedules: **primary `10 22 * * 1-5`**, **backstop `50 22 * * 1-5`** (UTC) —
after the close in both EDT and EST, matching the old InsForge rows.

The two InsForge `trading-tick` schedules have been **deleted**; the manifest in
[`../schedules/schedules.mjs`](../schedules/schedules.mjs) no longer lists them.

**Rollback:** the `trading-tick` edge function is still deployed. To revert,
re-create the two schedules (cron `10 22` / `50 22 * * 1-5`, URL
`.../functions/trading-tick`, header `X-Schedule-Secret`) and pause the Modal
crons (`modal app stop gold-butterfly-agents`, or disable in the dashboard).

## Not yet ported

- **PostHog events** (`agent_position_opened/closed`, `agent_tick_completed`)
  the edge function emitted. To restore, add `posthog` to the image, put
  `POSTHOG_API_KEY` in the secret, and emit from `process_agent` / the
  coordinator.
