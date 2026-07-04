# University Enricher — Command Reference

All commands are run from the `university-enricher` repo root. Every script loads its own `.env`, so just `cd university-enricher` first.

---

## 0. One-time setup checklist

| Need | Env var(s) |
|---|---|
| MongoDB | `MONGODB_URI` (⚠️ `update_qs_rankings_v5.js` alone uses `MONGO_URI` — see note at the bottom) |
| Redis (for the background enrichment queues) | `REDIS_URL` |
| AI providers (SEO meta + extraction) | `NVIDIA_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` (at least one required) |
| Google Search Console | `GSC_SERVICE_ACCOUNT_KEY_PATH` or `GSC_SERVICE_ACCOUNT_KEY_JSON`, `GSC_SITE_URL` |

---

## 1. Core content enrichment — Countries, Courses, Universities

This is **not** a one-off command per entity. It's a long-running background process: `app.js` boots BullMQ workers + schedulers that continuously scan MongoDB for incomplete records (missing `careerOpportunities`, `scholarships`, crawl data, etc.) and enrich them in batches, forever, until everything's complete.

```bash
node app.js
```

**What it does:**
- Starts the **university** scheduler (`queues/scheduler.js`) — finds universities with `crawlAttempts < 99` and enqueues them for crawling + AI extraction.
- Starts the **country** scheduler (`queues/countryScheduler.js`) — finds countries missing `careerOpportunities`/`scholarships`/`eligibilityRequirements`/`whyStudyCards` and enqueues them.
- Starts the **course** scheduler (`queues/courseScheduler.js`) — same idea, for course content (Phase 5b).
- Runs all the BullMQ workers (`queues/workers/`) that actually process each queue: crawl → AI extraction (multi-provider fallback) → validate → save.
- Logs enrichment stats every 5 minutes.

**Leave this running** (e.g. in a `screen`/`tmux` session, or as a systemd/PM2 service) — it's designed to run continuously, not to be started and stopped per batch. Ctrl+C to stop it (graceful shutdown closes Mongo/Redis connections cleanly).

---

## 2. Enrichment maintenance & one-off scripts

These are one-shot scripts you run manually when needed — not part of the always-on pipeline above.

### 2.1 Check university enrichment coverage
```bash
node scripts/check_coverage.js
```
Prints a report: total universities, how many are `isEnriched: true`, and a breakdown by `enrichment.status` (`completed` / `partial` / `failed` / `pending`). Read-only — use this to see whether the background enrichment in step 1 is actually making progress.

### 2.2 Patch specific missing fields without re-crawling
```bash
node scripts/reenrich_partials.js --dry-run              # preview only, writes nothing
node scripts/reenrich_partials.js                        # patch ALL missing fields it knows how to infer
node scripts/reenrich_partials.js --field tuitionFee      # patch only one field
node scripts/reenrich_partials.js --limit 1000            # cap how many records it touches
```
For universities stuck at `crawlAttempts >= 4` that the scheduler will never re-touch. Infers cheap fields (tuition, student count, similar universities) directly from country + name — no crawling, no AI calls. **Only fills fields that are currently empty** — never overwrites existing data.

### 2.3 Backfill University ↔ Course ↔ Country relationship links
```bash
node scripts/relationship-backfill.js --all --parallel 8       # full backfill, 8-way concurrency
node scripts/relationship-backfill.js --country canada          # just one country (safe test before --all)
node scripts/relationship-backfill.js --course mba               # just one course
node scripts/relationship-backfill.js --university oxford        # just one university
node scripts/relationship-backfill.js --all --dry-run            # compute + log only, write nothing
node scripts/relationship-backfill.js --all --resume              # continue an interrupted --all run
node scripts/relationship-backfill.js --all --parallel 8 --checkpoint 25   # checkpoint more often
```
Exactly one of `--all` / `--country` / `--course` / `--university` is required. Fixes universities that were enriched before automatic relationship-linking existed — links `university.courses`, `Country.topUniversities`/`popularCourses`, `Course.topUniversities`/`countries`. Resumable — checkpoints to MongoDB, survives crashes.

### 2.4 Report on unmatched AI-extracted programs
```bash
node scripts/unmatched-program-report.js
node scripts/unmatched-program-report.js --parallel 8
node scripts/unmatched-program-report.js --resume
node scripts/unmatched-program-report.js --out ./reports/custom-name.json
```
Read-only. Finds every (university, program) pair the AI extracted that doesn't match an existing Course record, and saves it two ways: a full JSON dump in `reports/`, and an aggregated, frequency-ranked `UnmatchedProgramReport` Mongo document — the actual input for deciding which new course categories to add to the catalog.

### 2.5 Update QS World Rankings
```bash
node update_qs_rankings_v5.js                          # dry run — shows what would change
node update_qs_rankings_v5.js --apply                  # actually writes to the DB
node update_qs_rankings_v5.js --apply --csv=./path/to/other-rankings.csv   # use a different CSV
```
Matches universities in the DB against `data/qs-world-rankings-2025.csv` (exact match → alias map → else sets `qsRanking: null`). **⚠️ This script alone reads `MONGO_URI`, not `MONGODB_URI` like everything else** — make sure both are set in your `.env` if you use this one, or you'll silently connect to nothing.

---

## 3. SEO title & description generation (Phase 7b — the CTR lever)

Google fully deprecated FAQ rich results in May 2026, so title/meta-description text is now the main thing you control for click-through rate. This script AI-generates them, with hard length limits and a pre-publish quality score — and only touches pages still on the generic template (never overwrites something already customized).

```bash
node scripts/generate_seo_meta.js --dry-run --entity country --limit 10
node scripts/generate_seo_meta.js --entity country --limit 50
node scripts/generate_seo_meta.js --entity course --limit 50
node scripts/generate_seo_meta.js --entity university --limit 50
node scripts/generate_seo_meta.js --entity country --priority-file ./gsc-priority-country.json --limit 300
node scripts/generate_seo_meta.js --entity country --force-slug canada
```

| Flag | What it does |
|---|---|
| `--entity <country\|course\|university>` | **Required.** Which collection to process. Run separately per entity type. |
| `--dry-run` | Preview generated titles/descriptions in the terminal — writes nothing to MongoDB. Always do this first on a new entity type. |
| `--limit <n>` | Max number of pages to touch in this run (default 100). Keeps AI-provider cost/load bounded per run. |
| `--priority-file <path>` | Feed in the output of `gsc_ctr_tracker.js --priority-out` (see below) so the highest-impression/lowest-CTR pages get rewritten first, instead of natural database order. **Recommended for any real batch.** |
| `--force-slug <slug>` | Regenerate one specific page by slug, ignoring the "already has a custom title" check — for re-doing a single page you didn't like. |

**Conservative merge, always on:** only rewrites a title/description if it's currently missing or still exactly the old generic-template string. A title you or a prior run of this script already wrote is never touched, with or without `--priority-file`.

---

## 4. Google Search Console — pull data & measure CTR (Phase 7c)

### 4.1 Pull fresh performance data from the real GSC API
```bash
node scripts/gsc_ctr_tracker.js --pull --days 90
```
Fetches Pages performance (clicks, impressions, CTR, position) for the last N days from your live Search Console property, and stores it in MongoDB as a dated "run" (e.g. `2026-07-04`). Also auto-classifies every URL into `country`/`course`/`university`/`blog`/`combo`/`other` by its path shape.

### 4.2 Seed your original historical export as the "before" baseline
```bash
node scripts/gsc_ctr_tracker.js --seed-baseline ./your-original-export.csv
```
One-time import of a manually-exported GSC CSV (Page/Clicks/Impressions/CTR/Position columns) as a run labeled `run-zero`. Do this once, with your oldest available export, so you have a genuine "before Phase 7" baseline to diff against later — a fresh `--pull` today is already too late to be a clean "before" for pages you've already rewritten.

### 4.3 Generate a priority list — worst CTR first
```bash
node scripts/gsc_ctr_tracker.js --priority-out ./gsc-priority-country.json --entity country --limit 300
node scripts/gsc_ctr_tracker.js --priority-out ./gsc-priority-university.json --entity university --limit 300
node scripts/gsc_ctr_tracker.js --priority-out ./gsc-priority-course.json --entity course --limit 300
```
Takes your most recent `--pull`, sorts by **lowest CTR first, then highest impressions**, and writes the top N to a JSON file — the exact "big impressions, near-zero CTR" pages that matter most. Feed this straight into `generate_seo_meta.js --priority-file`.

### 4.4 Measure whether a rewritten batch actually worked
```bash
node scripts/gsc_ctr_tracker.js --pull --days 30
node scripts/gsc_ctr_tracker.js --diff run-zero 2026-07-04
```
Compares two runs, but **only for URLs `generate_seo_meta.js` actually rewrote** (tracked via `metaRewritten: true`) — so the result is signal from your batch, not site-wide noise from unrelated ranking changes. Google needs to re-crawl a URL before a new title can even show up in the SERP — allow days to a few weeks after rewriting before running this.

---

## 5. Recommended end-to-end workflows

**"I want to improve CTR for all countries, properly, in priority order":**
```bash
node scripts/gsc_ctr_tracker.js --pull --days 90
node scripts/gsc_ctr_tracker.js --priority-out ./gsc-priority-country.json --entity country --limit 300
node scripts/generate_seo_meta.js --entity country --priority-file ./gsc-priority-country.json --limit 300
# ...wait days-to-weeks for Google to recrawl...
node scripts/gsc_ctr_tracker.js --pull --days 30
node scripts/gsc_ctr_tracker.js --diff run-zero <today's-run-label>
```

**"I want to do the same for courses and universities":** repeat the block above with `--entity course` / `--entity university` and their own priority files.

**"I just want the enrichment pipeline running so new/incomplete records get filled in over time":**
```bash
node app.js
# leave it running; check progress periodically:
node scripts/check_coverage.js
```

**"A batch of universities got stuck and will never re-crawl":**
```bash
node scripts/reenrich_partials.js --dry-run
node scripts/reenrich_partials.js
```

**"I just added/changed a lot of course or university data and links look wrong":**
```bash
node scripts/relationship-backfill.js --all --dry-run
node scripts/relationship-backfill.js --all --parallel 8
```

---

## Known gotchas worth remembering

- **`update_qs_rankings_v5.js` reads `MONGO_URI`, everything else reads `MONGODB_URI`.** Set both if you use it.
- **Always `--dry-run` a new `--entity` in `generate_seo_meta.js` before a real run** — cheap insurance, no DB writes.
- **`app.js` is a long-running process, not a batch job** — don't expect it to "finish"; it just keeps working through whatever's incomplete every 5 minutes.
- **The AI model registry (`ai/multiProviderClient.js`) has a few dead/retired free-tier model entries** (some Groq and OpenRouter slugs return `400`/`404` reliably, not intermittently) — they don't cause failures (the fallback chain routes around them) but they do waste time on every single call. Worth pruning once you've confirmed which ones are consistently dead in your logs.
