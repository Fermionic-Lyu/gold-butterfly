# Daily news scraper (Modal)

This directory holds the one part of Gold Butterfly that runs **off** InsForge:
a [Modal](https://modal.com) cron job that scrapes daily financial news for the
full tracked instrument universe.

Everything else in the pipeline stays in-stack. The flow is:

```
Modal cron (08:30 UTC daily)
  └─ scrape_news.py: for every tracked symbol, pull from
       Finnhub /company-news + Yahoo Finance RSS + Google News RSS,
       extract article bodies (trafilatura), upsert → company_news
  └─ on finish, POST → InsForge functions/analyze-news
       (LLM digest, scoped to subscribed symbols only)
                         └─ LLM digest per symbol → news_analyses
                              └─ React "News" tab reads both tables
```

**Why Modal and not an InsForge edge function?** Real multi-source scraping
wants long runtime, wide parallel fan-out, and the Python scraping stack
(trafilatura et al) — none of which Deno edge functions offer. The rest of the
pipeline (storage, the LLM digest) has no such need and stays inside InsForge.

## One-time setup

1. Install and authenticate Modal:

   ```sh
   pip install modal
   modal setup
   ```

2. Create the Modal secret the job reads. All four values come from your
   existing InsForge project / Finnhub account:

   ```sh
   modal secret create gold-butterfly \
     INSFORGE_BASE_URL="https://<your-project>.us-east.insforge.app" \
     INSFORGE_API_KEY="<insforge project/service api key>" \
     FINNHUB_API_KEY="<your finnhub key>" \
     SCHEDULE_SECRET="<the same SCHEDULE_SECRET you set in InsForge>"
   ```

   - **INSFORGE_API_KEY** must be a privileged project/service key (the kind in
     `.insforge/project.json`) — it writes to `company_news`, so it has to
     bypass RLS. Generate one in the InsForge dashboard if you don't have it.
   - **SCHEDULE_SECRET** must match the platform secret you already set with
     `insforge secrets add SCHEDULE_SECRET ...`, so the scraper can trigger
     `analyze-news` the same way the cron does.

3. Make sure the InsForge side is deployed first (`npm run setup` from the repo
   root) so the `company_news` / `news_analyses` tables and the `analyze-news`
   function exist.

## Run it

```sh
# Register the daily cron on Modal (08:30 UTC):
modal deploy modal/scrape_news.py

# One-off manual run to verify end-to-end:
modal run modal/scrape_news.py
```

A manual run prints a summary like:

```
{'symbols': 12, 'articles_written': 138, 'symbol_errors': 0,
 'analysis_trigger': {'triggered': True, 'status': 200, ...}, 'elapsed_s': 41.3}
```

Then open the app, pick a subscribed symbol, and check the **News** tab. (Every
symbol gets scraped headlines; the AI digest only appears for symbols in a
user's watchlist.)

## Tuning knobs (top of `scrape_news.py`)

| Constant | Default | Meaning |
|---|---|---|
| `MAX_ARTICLES_PER_SYMBOL` | `12` | Newest N items stored per symbol per run. |
| `MAX_FULLTEXT_FETCHES` | `8` | Of those, how many get a full-body extraction. |
| `LOOKBACK_DAYS` | `2` | Finnhub news window (yesterday + today). |
| `max_containers` (on `scrape_symbol`) | `8` | Parallel fan-out cap — keeps Finnhub calls under its free 60/min limit. |

The cron expression lives in the `@app.function(..., schedule=modal.Cron(...))`
decorator on `daily()`. The in-stack backstop that re-runs the analysis if the
trigger is missed is `"Analyze company news"` in
[`../schedules/schedules.mjs`](../schedules/schedules.mjs).
