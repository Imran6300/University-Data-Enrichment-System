/**
 * relationship-backfill.js — Relationship Graph Backfill Worker
 *
 * FIXES AUDIT FINDING #2, RETROACTIVELY (Phase-0 architecture audit,
 * 2026-07): relationshipGraph.js (added 2026-07) now runs automatically
 * for every NEW enrichment job, but the ~9,000 universities enriched
 * BEFORE that fix went in are still graph-orphaned — no
 * university.courses, no Country.topUniversities/popularCourses, no
 * Course.topUniversities/countries. This worker walks the existing
 * corpus and reconciles all of it, using the exact same matching logic
 * (relationshipGraph.js) as the live enrichment pipeline, so there is
 * only one place that "what counts as a match" is defined.
 *
 * This is a WORKER, not a one-off script: it is resumable, checkpointed
 * to MongoDB (survives crashes/restarts), runs with bounded concurrency,
 * supports dry-run, and can be scoped to a country, a single course, or
 * a single university for safe, incremental rollout instead of one big
 * all-or-nothing pass over 9,000 records.
 *
 * ─────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────
 *
 *   # Full backfill, 8-way concurrency
 *   node scripts/relationship-backfill.js --all --parallel 8
 *
 *   # Just one country (safe way to validate before running --all)
 *   node scripts/relationship-backfill.js --country canada
 *
 *   # Just one course — only links THIS course, ignores all others
 *   # (useful for auditing/fixing a single course's linkage, or for
 *   # validating a newly-created Course record against the corpus)
 *   node scripts/relationship-backfill.js --course mba
 *
 *   # Just one university (debugging / spot-check)
 *   node scripts/relationship-backfill.js --university oxford
 *
 *   # See what WOULD happen without writing anything
 *   node scripts/relationship-backfill.js --all --dry-run
 *
 *   # Resume a previous --all run that was interrupted
 *   node scripts/relationship-backfill.js --all --resume
 *
 *   # Write a checkpoint every 25 universities instead of the default 50
 *   node scripts/relationship-backfill.js --all --parallel 8 --checkpoint 25
 *
 * Flags:
 *   --all                  scope: every eligible university
 *   --country <slug>       scope: universities in one country
 *   --course <slug>        scope: only reconcile links to this one course
 *   --university <slug>    scope: a single university
 *   --resume               continue from the last checkpoint for this scope
 *   --parallel <n>         concurrency (default 4)
 *   --dry-run              compute + log matches, write nothing, no checkpoint writes
 *   --checkpoint <n>       checkpoint every n processed universities (default 50)
 *
 * Exactly one of --all / --country / --course / --university is required.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const pLimit = require("p-limit");

const University = require("../models/universities");
const Country = require("../models/countries");
const Course = require("../models/courses");
const Checkpoint = require("../models/relationshipBackfillCheckpoint");
const { reconcileUniversityGraph } = require("../queues/relationshipGraph");

// ── CLI parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagValue(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const next = args[idx + 1];
  return next && !next.startsWith("--") ? next : fallback;
}

const MODE_ALL = args.includes("--all");
const COUNTRY_SLUG = flagValue("--country");
const COURSE_SLUG = flagValue("--course");
const UNIVERSITY_SLUG = flagValue("--university");
const RESUME = args.includes("--resume");
const DRY_RUN = args.includes("--dry-run");
const PARALLEL = parseInt(flagValue("--parallel", "4"), 10) || 4;
const CHECKPOINT_EVERY = parseInt(flagValue("--checkpoint", "50"), 10) || 50;

const scopesGiven = [
  MODE_ALL,
  !!COUNTRY_SLUG,
  !!COURSE_SLUG,
  !!UNIVERSITY_SLUG,
].filter(Boolean).length;

if (scopesGiven !== 1) {
  console.error(
    "❌ Specify exactly one scope: --all, --country <slug>, --course <slug>, or --university <slug>\n",
  );
  console.error("Examples:");
  console.error("  node scripts/relationship-backfill.js --all --parallel 8");
  console.error("  node scripts/relationship-backfill.js --country canada");
  console.error("  node scripts/relationship-backfill.js --course mba");
  console.error(
    "  node scripts/relationship-backfill.js --university oxford --dry-run",
  );
  process.exit(1);
}

const MODE = MODE_ALL
  ? "all"
  : COUNTRY_SLUG
    ? "country"
    : COURSE_SLUG
      ? "course"
      : "university";
const SCOPE_VALUE = COUNTRY_SLUG || COURSE_SLUG || UNIVERSITY_SLUG || null;
const RUN_KEY = SCOPE_VALUE ? `${MODE}:${SCOPE_VALUE}` : MODE;

// ── Quality filter — same bar as sitemapController's university filter,  ──
// ── so the backfill never links graph-orphaned low-quality stub records  ──
const ELIGIBILITY_FILTER = {
  $or: [
    { "enrichment.status": "completed" },
    { isEnriched: true },
    {
      $expr: {
        $gte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 300],
      },
    },
  ],
  country: { $exists: true, $ne: null },
};

// ── Scope resolution ─────────────────────────────────────────────────────

async function resolveScope() {
  let query = { ...ELIGIBILITY_FILTER };
  let restrictCourseId = null;
  let label = "ALL eligible universities";

  if (MODE === "country") {
    const country = await Country.findOne({
      slug: new RegExp(`^${escapeRegex(COUNTRY_SLUG)}$`, "i"),
    })
      .select("_id name")
      .lean();
    if (!country) {
      throw new Error(`No country found matching slug "${COUNTRY_SLUG}"`);
    }
    query.country = country._id;
    label = `Country: ${country.name}`;
  }

  if (MODE === "course") {
    const course = await Course.findOne({
      slug: new RegExp(`^${escapeRegex(COURSE_SLUG)}$`, "i"),
    })
      .select("_id title field")
      .lean();
    if (!course) {
      throw new Error(`No course found matching slug "${COURSE_SLUG}"`);
    }
    restrictCourseId = course._id.toString();
    // Pre-filter to universities whose extracted programs plausibly
    // mention this course, so we're not scanning the whole corpus for a
    // single-course run.
    const keyword = (course.title || "").split(/\s+/)[0];
    query["programs.category"] = new RegExp(escapeRegex(keyword), "i");
    label = `Course: ${course.title}`;
  }

  if (MODE === "university") {
    const uni = await University.findOne({
      slug: new RegExp(`^${escapeRegex(UNIVERSITY_SLUG)}$`, "i"),
    })
      .select("_id name")
      .lean();
    if (!uni) {
      throw new Error(`No university found matching slug "${UNIVERSITY_SLUG}"`);
    }
    query._id = uni._id;
    // Single-university runs bypass the eligibility filter deliberately —
    // this mode is for debugging/spot-checking a specific record.
    query = { _id: uni._id };
    label = `University: ${uni.name}`;
  }

  return { query, restrictCourseId, label };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Checkpoint handling ──────────────────────────────────────────────────

async function loadOrCreateCheckpoint(totalInScope) {
  if (DRY_RUN) {
    // Dry runs never persist state — every dry-run is a fresh preview.
    return {
      runKey: RUN_KEY,
      mode: MODE,
      scopeValue: SCOPE_VALUE,
      lastProcessedId: null,
      processedCount: 0,
      matchedCourseLinks: 0,
      unmatchedPrograms: 0,
      skippedCount: 0,
      errorCount: 0,
      totalInScope,
      recentErrors: [],
      _isEphemeral: true,
    };
  }

  let checkpoint = await Checkpoint.findOne({ runKey: RUN_KEY });

  if (checkpoint && RESUME) {
    console.log(
      `↻  Resuming "${RUN_KEY}" from checkpoint: ${checkpoint.processedCount}/${checkpoint.totalInScope} already processed ` +
        `(last id ${checkpoint.lastProcessedId || "none"})\n`,
    );
    checkpoint.status = "running";
    checkpoint.totalInScope = totalInScope; // scope size may have grown
    await checkpoint.save();
    return checkpoint;
  }

  if (checkpoint && !RESUME) {
    console.log(
      `⚠️  A previous checkpoint exists for "${RUN_KEY}" (${checkpoint.processedCount}/${checkpoint.totalInScope} processed, ` +
        `status=${checkpoint.status}). Starting FRESH — pass --resume to continue it instead.\n`,
    );
    checkpoint.lastProcessedId = null;
    checkpoint.processedCount = 0;
    checkpoint.matchedCourseLinks = 0;
    checkpoint.unmatchedPrograms = 0;
    checkpoint.skippedCount = 0;
    checkpoint.errorCount = 0;
    checkpoint.recentErrors = [];
    checkpoint.status = "running";
    checkpoint.totalInScope = totalInScope;
    checkpoint.startedAt = new Date();
    checkpoint.completedAt = null;
    await checkpoint.save();
    return checkpoint;
  }

  checkpoint = await Checkpoint.create({
    runKey: RUN_KEY,
    mode: MODE,
    scopeValue: SCOPE_VALUE,
    totalInScope,
    dryRun: false,
  });
  return checkpoint;
}

async function persistCheckpoint(checkpoint, patch) {
  Object.assign(checkpoint, patch, { lastCheckpointAt: new Date() });
  if (checkpoint._isEphemeral) return; // dry-run — nothing to persist
  await checkpoint.save();
}

// ── Progress UI ───────────────────────────────────────────────────────────

function progressBar(n, total, width = 24) {
  const pct = total > 0 ? n / total : 0;
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${(pct * 100).toFixed(1)}%`;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? h + "h " : ""}${m}m ${sec}s`;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  const { query, restrictCourseId, label } = await resolveScope();
  const totalInScope = await University.countDocuments(query);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  RELATIONSHIP BACKFILL WORKER");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Scope:        ${label}`);
  console.log(`  Run key:      ${RUN_KEY}`);
  console.log(`  In scope:     ${totalInScope.toLocaleString()} universities`);
  console.log(`  Concurrency:  ${PARALLEL}`);
  console.log(`  Mode:         ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  Checkpoint:   every ${CHECKPOINT_EVERY} universities`);
  console.log("═══════════════════════════════════════════════════════\n");

  if (totalInScope === 0) {
    console.log("Nothing in scope — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  const checkpoint = await loadOrCreateCheckpoint(totalInScope);

  const cursorQuery = checkpoint.lastProcessedId
    ? { ...query, _id: { $gt: checkpoint.lastProcessedId } }
    : query;

  const limit = pLimit(PARALLEL);
  const startTime = Date.now();

  let processedSinceCheckpoint = 0;
  let shuttingDown = false;

  // Graceful shutdown: flush the checkpoint before exiting so a Ctrl+C or
  // a process manager restart doesn't lose progress.
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\n⏸  Received ${signal}, flushing checkpoint...`);
    await persistCheckpoint(checkpoint, { status: "paused" });
    console.log(
      `✅ Checkpoint saved at ${checkpoint.processedCount}/${checkpoint.totalInScope}. ` +
        `Resume with: node scripts/relationship-backfill.js ${scopeFlagString()} --resume\n`,
    );
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const cursor = University.find(cursorQuery)
    .select("_id name country programs")
    .sort({ _id: 1 })
    .lean()
    .cursor();

  const tasks = [];

  for await (const uni of cursor) {
    if (shuttingDown) break;

    tasks.push(
      limit(async () => {
        if (shuttingDown) return;
        try {
          const programs = Array.isArray(uni.programs) ? uni.programs : [];

          if (programs.length === 0 && !uni.country) {
            checkpoint.skippedCount++;
          } else {
            const { courseIds, unmatched } = await reconcileUniversityGraph({
              universityId: uni._id,
              universityName: uni.name,
              countryId: uni.country,
              programs,
              dryRun: DRY_RUN,
              restrictCourseId,
              quiet: true,
            });
            checkpoint.matchedCourseLinks += courseIds.length;
            checkpoint.unmatchedPrograms += unmatched.length;
          }
        } catch (err) {
          checkpoint.errorCount++;
          checkpoint.recentErrors = [
            ...(checkpoint.recentErrors || []).slice(-19),
            {
              universityId: uni._id,
              universityName: uni.name,
              message: err.message,
              at: new Date(),
            },
          ];
          console.warn(`  ⚠️  [${uni.name}] ${err.message}`);
        } finally {
          checkpoint.processedCount++;
          checkpoint.lastProcessedId = uni._id;
          processedSinceCheckpoint++;

          process.stdout.write(
            `\r  ${progressBar(checkpoint.processedCount, checkpoint.totalInScope)} ` +
              `${checkpoint.processedCount}/${checkpoint.totalInScope} | ` +
              `linked=${checkpoint.matchedCourseLinks} unmatched=${checkpoint.unmatchedPrograms} ` +
              `skipped=${checkpoint.skippedCount} errors=${checkpoint.errorCount}   `,
          );

          if (processedSinceCheckpoint >= CHECKPOINT_EVERY) {
            processedSinceCheckpoint = 0;
            await persistCheckpoint(checkpoint, { status: "running" });
          }
        }
      }),
    );

    // Keep the in-flight task queue bounded so we don't buffer the entire
    // 9,000-record cursor's worth of promises in memory at once.
    if (tasks.length >= PARALLEL * 4) {
      await Promise.all(tasks.splice(0, tasks.length));
    }
  }

  await Promise.all(tasks);

  if (!shuttingDown) {
    await persistCheckpoint(checkpoint, {
      status: "completed",
      completedAt: new Date(),
    });
  }

  const elapsed = Date.now() - startTime;
  console.log("\n\n═══════════════════════════════════════════════════════");
  console.log(`  ${DRY_RUN ? "DRY RUN " : ""}COMPLETE — ${label}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(
    `  Processed:          ${checkpoint.processedCount.toLocaleString()}`,
  );
  console.log(
    `  Course links made:  ${checkpoint.matchedCourseLinks.toLocaleString()}`,
  );
  console.log(
    `  Unmatched programs: ${checkpoint.unmatchedPrograms.toLocaleString()} (no existing Course record — candidates for Phase 5)`,
  );
  console.log(
    `  Skipped (no data):  ${checkpoint.skippedCount.toLocaleString()}`,
  );
  console.log(
    `  Errors:             ${checkpoint.errorCount.toLocaleString()}`,
  );
  console.log(`  Elapsed:            ${fmtDuration(elapsed)}`);
  if (DRY_RUN) {
    console.log(`\n  Nothing was written. Re-run without --dry-run to apply.`);
  }
  console.log("═══════════════════════════════════════════════════════\n");

  await mongoose.disconnect();
}

function scopeFlagString() {
  if (MODE === "all") return "--all";
  return `--${MODE} ${SCOPE_VALUE}`;
}

main().catch(async (err) => {
  console.error("\n❌ Fatal:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
