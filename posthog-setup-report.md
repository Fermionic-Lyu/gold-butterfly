<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Gold Butterfly's server-side edge functions. Two Deno edge functions — the AI strategy analysis endpoint and the daily trading agent tick — now capture key business events using `posthog-node` via Deno's `npm:` import system. Each function initializes a short-lived PostHog client (flushAt: 1, flushInterval: 0) so events are sent immediately before the response is returned. User identification is performed on every authenticated strategy analysis request. Exceptions are captured via `captureException` in all error handlers, with `enableExceptionAutocapture: true` set on the client.

| Event | Description | File |
|---|---|---|
| `strategy_analysis_requested` | User requests AI strategy analysis for an options symbol | `functions/strategy-analysis.ts` |
| `strategy_analysis_completed` | AI strategy analysis successfully completed and returned strategies | `functions/strategy-analysis.ts` |
| `agent_position_opened` | Trading agent opened a new options position after daily tick | `functions/trading-tick.ts` |
| `agent_position_closed` | Trading agent closed an existing options position after daily tick | `functions/trading-tick.ts` |
| `agent_tick_completed` | Trading agent daily tick completed with position decisions for all agents | `functions/trading-tick.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1643937)
- [Strategy Analysis Requests Over Time](/insights/HpyTItRw) — daily request volume
- [Strategy Analysis: Requests vs Completions](/insights/xwv0p6sJ) — gap signals failures or retries
- [Strategy Analysis Average Latency](/insights/G4s4RsqB) — average `took_ms` per day; spikes indicate OpenRouter degradation
- [Agent Positions Opened vs Closed](/insights/Agk0hRD1) — portfolio activity; imbalance signals buildup or drawdown
- [Daily Active Strategy Users](/insights/SMamQgTv) — unique users per day using AI strategy analysis

### Environment variables

Set the following environment variables in your InsForge project settings so the edge functions can reach PostHog:

- `POSTHOG_API_KEY` — your PostHog project API key
- `POSTHOG_HOST` — `https://us.i.posthog.com`

These are already written to your local `.env` file for the Node.js context.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
