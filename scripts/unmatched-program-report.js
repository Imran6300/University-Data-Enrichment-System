/**
 * unmatched-program-report.js — Phase 5, Step 1: Unmatched Program Frequency Report
 *
 * WHY THIS EXISTS (see checkpoint doc, "Remaining Tasks" / Phase 5):
 * The Phase 2 relationship-backfill run (scripts/relationship-backfill.js)
 * found 16,774 AI-extracted programs with no matching existing Course
 * record, but that figure was only ever printed to a terminal — never
 * saved to a file or database. That list must be assumed lost. This
 * script re-derives it from scratch, and this time PERSISTS the result
 * (JSON file + a UnmatchedProgramReport Mongo document) before any
 * Course-catalog-expansion decision gets made from it.
 *
 * This script is READ-ONLY. It never calls reconcileUniversityGraph() and
 * never writes to University/Country/Course documents — it only calls
 * matchProgramsToCourses(), which is a pure matching function with no
 * side effects, reused as-is from queues/relationshipGraph.js so "what
 * counts as a match" stays defined in exactly one place (the same
 * function the live enrichment worker and the Phase 2 backfill use).
 *
 * WHAT IT PRODUCES:
 *   1. reports/unmatched-programs-<timestamp>.json — every unmatched
 *      (university, program) pair, untruncated.
 *   2. An UnmatchedProgramReport Mongo document — the same data,
 *      aggregated and ranked by frequency (how many universities offer
 *      something in that category), which is the actual Phase 5 input:
 *      "which missing course categories would unlock the most additional
 *      University<->Course links and combo pages."
 *
 * USAGE:
 *   node scripts/unmatched-program-report.js
 *   node scripts/unmatched-program-report.js --parallel 8
 *   node scripts/unmatched-program-report.js --resume
 *   node scripts/unmatched-program-report.js --out ./reports/custom-name.json
 *
 * Scope: reuses the EXACT SAME eligibility filter as
 * scripts/relationship-backfill.js (imported, not re-declared), so the
 * population scanned here matches what production matching actually sees
 * — comparable to the original "8,655 universities processed" figure.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const pLimit = require("p-limit");

const University = require("../models/universities");
const UnmatchedProgramReport = require("../models/unmatchedProgramReport");
const { matchProgramsToCourses } = require("../queues/relationshipGraph");
const { ELIGIBILITY_FILTER } = require("./lib/eligibility");

// ── CLI parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagValue(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const next = args[idx + 1];
  return next && !next.startsWith("--") ? next : fallback;
}

const RESUME = args.includes("--resume");
const PARALLEL = parseInt(flagValue("--parallel", "4"), 10) || 4;
const CHECKPOINT_EVERY = parseInt(flagValue("--checkpoint", "100"), 10) || 100;
const RUN_KEY = flagValue("--run-key", "phase5-unmatched-report");

const REPORTS_DIR = path.join(__dirname, "..", "reports");
const OUT_FILE =
  flagValue("--out") ||
  path.join(
    REPORTS_DIR,
    `unmatched-programs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

// ── Category normalization ──────────────────────────────────────────────

function normalizeCategory(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ── Progress UI (same shape as relationship-backfill.js) ────────────────

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

// ── Checkpoint handling ──────────────────────────────────────────────────

async function loadOrCreateReport(totalInScope) {
  let report = await UnmatchedProgramReport.findOne({ runKey: RUN_KEY });

  if (report && RESUME && report.status !== "completed") {
    console.log(
      `↻  Resuming "${RUN_KEY}" from checkpoint: ${report.universitiesScanned}/${report.totalUniversitiesInScope} already scanned ` +
        `(last id ${report.lastProcessedId || "none"})\n`,
    );
    report.status = "running";
    return { report, rawUnmatched: loadPartialRaw(report.outputFile) };
  }

  if (report) {
    console.log(
      `⚠️  Existing report "${RUN_KEY}" found (status: ${report.status}) — starting a fresh run and overwriting it. ` +
        `Use --resume to continue it instead, or --run-key to run a differently-named report alongside it.\n`,
    );
    report.lastProcessedId = null;
    report.universitiesScanned = 0;
    report.totalProgramsScanned = 0;
    report.totalMatched = 0;
    report.totalUnmatched = 0;
    report.uniqueUnmatchedCategories = 0;
    report.errorCount = 0;
    report.rankedCategories = [];
    report.status = "running";
    report.totalUniversitiesInScope = totalInScope;
    report.startedAt = new Date();
    report.completedAt = null;
    await report.save();
    return { report, rawUnmatched: [] };
  }

  report = await UnmatchedProgramReport.create({
    runKey: RUN_KEY,
    totalUniversitiesInScope: totalInScope,
  });
  return { report, rawUnmatched: [] };
}

function loadPartialRaw(outputFile) {
  if (!outputFile) return [];
  try {
    return JSON.parse(fs.readFileSync(outputFile, "utf8"));
  } catch (_) {
    return [];
  }
}

async function persistReport(report, patch) {
  Object.assign(report, patch, { lastCheckpointAt: new Date() });
  await report.save();
}

function writeRawFile(outFile, rawUnmatched) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(rawUnmatched, null, 2));
}

// ── Aggregation ───────────────────────────────────────────────────────────

function aggregate(rawUnmatched) {
  const byCategory = new Map();

  for (const entry of rawUnmatched) {
    const key = normalizeCategory(entry.category);
    if (!key) continue;

    if (!byCategory.has(key)) {
      byCategory.set(key, {
        category: key,
        sampleLabel: entry.category,
        count: 0,
        universityIds: new Set(),
        levels: {},
        sampleUniversities: [],
      });
    }

    const bucket = byCategory.get(key);
    bucket.count++;
    bucket.universityIds.add(entry.universityId);
    if (entry.level) {
      bucket.levels[entry.level] = (bucket.levels[entry.level] || 0) + 1;
    }
    if (
      bucket.sampleUniversities.length < 8 &&
      !bucket.sampleUniversities.includes(entry.universityName)
    ) {
      bucket.sampleUniversities.push(entry.universityName);
    }
  }

  const ranked = [...byCategory.values()]
    .map((b) => ({
      category: b.category,
      sampleLabel: b.sampleLabel,
      count: b.count,
      universityCount: b.universityIds.size,
      levels: b.levels,
      sampleUniversities: b.sampleUniversities,
    }))
    .sort((a, b) => b.universityCount - a.universityCount || b.count - a.count);

  return ranked;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  const totalInScope = await University.countDocuments(ELIGIBILITY_FILTER);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  UNMATCHED PROGRAM FREQUENCY REPORT (Phase 5, Step 1)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Run key:      ${RUN_KEY}`);
  console.log(`  In scope:     ${totalInScope.toLocaleString()} universities`);
  console.log(`  Concurrency:  ${PARALLEL}`);
  console.log(`  Output file:  ${OUT_FILE}`);
  console.log(
    `  Mode:         READ-ONLY (no writes to University/Country/Course)`,
  );
  console.log("═══════════════════════════════════════════════════════\n");

  if (totalInScope === 0) {
    console.log("Nothing in scope — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  const { report, rawUnmatched } = await loadOrCreateReport(totalInScope);
  report.outputFile = OUT_FILE;

  const cursorQuery = report.lastProcessedId
    ? { ...ELIGIBILITY_FILTER, _id: { $gt: report.lastProcessedId } }
    : ELIGIBILITY_FILTER;

  const limit = pLimit(PARALLEL);
  const startTime = Date.now();

  let processedSinceCheckpoint = 0;
  let shuttingDown = false;

  const flush = async (status) => {
    writeRawFile(OUT_FILE, rawUnmatched);
    const ranked = aggregate(rawUnmatched);
    await persistReport(report, {
      status,
      rankedCategories: ranked,
      uniqueUnmatchedCategories: ranked.length,
    });
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `\n\n⏸  Received ${signal}, flushing report to disk + Mongo...`,
    );
    await flush("paused");
    console.log(
      `✅ Saved at ${report.universitiesScanned}/${report.totalUniversitiesInScope}. ` +
        `Resume with: node scripts/unmatched-program-report.js --resume --run-key ${RUN_KEY}\n`,
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
          report.totalProgramsScanned += programs.length;

          if (programs.length > 0) {
            const { courseIds, unmatched } =
              await matchProgramsToCourses(programs);
            report.totalMatched += courseIds.length;
            report.totalUnmatched += unmatched.length;

            for (const program of unmatched) {
              rawUnmatched.push({
                universityId: uni._id.toString(),
                universityName: uni.name,
                countryId: uni.country ? uni.country.toString() : null,
                category: program.category,
                level: program.level || null,
              });
            }
          }
        } catch (err) {
          report.errorCount++;
          console.warn(`  ⚠️  [${uni.name}] ${err.message}`);
        } finally {
          report.universitiesScanned++;
          report.lastProcessedId = uni._id;
          processedSinceCheckpoint++;

          process.stdout.write(
            `\r  ${progressBar(report.universitiesScanned, report.totalUniversitiesInScope)} ` +
              `${report.universitiesScanned}/${report.totalUniversitiesInScope} | ` +
              `matched=${report.totalMatched} unmatched=${report.totalUnmatched} errors=${report.errorCount}   `,
          );

          if (processedSinceCheckpoint >= CHECKPOINT_EVERY) {
            processedSinceCheckpoint = 0;
            await flush("running");
          }
        }
      }),
    );

    if (tasks.length >= PARALLEL * 4) {
      await Promise.all(tasks.splice(0, tasks.length));
    }
  }

  await Promise.all(tasks);

  if (!shuttingDown) {
    await flush("completed");
    await persistReport(report, { completedAt: new Date() });
  }

  const elapsed = Date.now() - startTime;
  const ranked = report.rankedCategories;

  console.log("\n\n═══════════════════════════════════════════════════════");
  console.log(`  COMPLETE — Unmatched Program Frequency Report`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(
    `  Universities scanned:      ${report.universitiesScanned.toLocaleString()}`,
  );
  console.log(
    `  Programs scanned:          ${report.totalProgramsScanned.toLocaleString()}`,
  );
  console.log(
    `  Matched to existing Course:${" ".repeat(1)}${report.totalMatched.toLocaleString()}`,
  );
  console.log(
    `  Unmatched:                 ${report.totalUnmatched.toLocaleString()}`,
  );
  console.log(
    `  Unique unmatched categories:${report.uniqueUnmatchedCategories.toLocaleString()}`,
  );
  console.log(
    `  Errors:                    ${report.errorCount.toLocaleString()}`,
  );
  console.log(`  Elapsed:                   ${fmtDuration(elapsed)}`);
  console.log(`  Raw dump:                  ${OUT_FILE}`);
  console.log(
    `  Mongo doc:                 UnmatchedProgramReport { runKey: "${RUN_KEY}" }`,
  );
  console.log("\n  Top 20 unmatched categories by university count:");
  console.log("  ────────────────────────────────────────────────");
  ranked.slice(0, 20).forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.sampleLabel.padEnd(40)} unis=${String(r.universityCount).padStart(4)}  total=${String(r.count).padStart(4)}  levels=${JSON.stringify(r.levels)}`,
    );
  });
  console.log("═══════════════════════════════════════════════════════\n");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n❌ Fatal:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
