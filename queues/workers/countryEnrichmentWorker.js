/**
 * countryEnrichmentWorker.js
 *
 * PHASE 4 (2026-07): BullMQ worker for country content enrichment.
 * Migrated from services/scripts/enrichCountries.js. Same job-handling
 * shape as enrichmentWorker.js (timeout race, graceful shutdown) so
 * anyone maintaining this codebase only needs to learn one pattern.
 *
 * SCOPE, DELIBERATELY NARROW: this worker ONLY writes
 * careerOpportunities, scholarships, eligibilityRequirements, and
 * whyStudyCards. It does NOT touch topUniversities or popularCourses —
 * those are ObjectId ref arrays that relationshipGraph.js (Phase 2)
 * populates from real, matched University/Course documents. The old
 * script tried to write AI-generated name strings into those same two
 * ref fields, which Mongoose could not cast — that was a standing bug,
 * confirmed while building this migration, not something this migration
 * introduced. See the removed field assignments in the original script
 * for reference; they are intentionally not ported forward.
 *
 * Like the original script, this only fills fields that are currently
 * EMPTY — it never overwrites existing content (conservative merge,
 * same philosophy as the university pipeline's coalesce() helper).
 */

const { Worker } = require("bullmq");
const { QUEUE_NAME } = require("../countryEnrichmentQueue");
const { getBullMQConnection } = require("../../utils/redis");

const Country = require("../../models/countries");
const { extractCountryData } = require("../../ai/extractCountryData");

const WORKER_CONCURRENCY =
  parseInt(process.env.COUNTRY_WORKER_CONCURRENCY) || 2;
const PER_JOB_TIMEOUT_MS =
  parseInt(process.env.COUNTRY_JOB_TIMEOUT_MS) || 3 * 60 * 1000;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const JOB_THROTTLE_MS = parseInt(process.env.COUNTRY_JOB_THROTTLE_MS) || 1500;

const stats = { completed: 0, failed: 0, retries: 0 };

function printStats() {
  console.log(
    `📊 Country stats: completed=${stats.completed} failed=${stats.failed} retries=${stats.retries}`,
  );
}

// ─────────────────────────────────────────────
// Per-country processing
// ─────────────────────────────────────────────
async function processCountry(countryId, countryName) {
  const country = await Country.findById(countryId);
  if (!country) {
    return { success: false, reason: "Country not found" };
  }

  const needsEnrichment =
    !country.careerOpportunities?.length ||
    !country.scholarships?.length ||
    !country.eligibilityRequirements?.length ||
    !country.whyStudyCards?.length;

  if (!needsEnrichment) {
    console.log(`⏭️  [${countryName}] Already fully enriched — skipping`);
    return { success: true, skipped: true };
  }

  const parsed = await extractCountryData(countryName);

  const update = {};
  if (!country.careerOpportunities?.length) {
    update.careerOpportunities = parsed.careerOpportunities;
  }
  if (!country.scholarships?.length) {
    update.scholarships = parsed.scholarships;
  }
  if (!country.eligibilityRequirements?.length) {
    update.eligibilityRequirements = parsed.eligibilityRequirements;
  }
  if (!country.whyStudyCards?.length) {
    update.whyStudyCards = parsed.whyStudyCards;
  }

  if (Object.keys(update).length === 0) {
    return { success: true, skipped: true };
  }

  await Country.findByIdAndUpdate(countryId, update, { runValidators: true });

  console.log(
    `💾 [${countryName}] Saved (${Object.keys(update).join(", ")}) via ${parsed._model}`,
  );

  return { success: true, fieldsUpdated: Object.keys(update) };
}

// ─────────────────────────────────────────────
// Worker initialization
// ─────────────────────────────────────────────
function initCountryEnrichmentWorker() {
  console.log(
    `👷 Country enrichment worker: concurrency=${WORKER_CONCURRENCY} | timeout=${PER_JOB_TIMEOUT_MS / 60000}min`,
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (JOB_THROTTLE_MS > 0) {
        await new Promise((r) => setTimeout(r, JOB_THROTTLE_MS));
      }

      if (job.attemptsMade > 0) stats.retries++;

      const { countryId, countryName } = job.data;
      console.log(
        `\n🚀 [${countryName}] Starting country enrichment (attempt ${job.attemptsMade + 1})`,
      );

      const jobTimeout = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Job timeout after ${PER_JOB_TIMEOUT_MS / 1000}s`),
            ),
          PER_JOB_TIMEOUT_MS,
        ),
      );

      return Promise.race([processCountry(countryId, countryName), jobTimeout]);
    },
    {
      connection: getBullMQConnection(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: 60 * 1000,
      maxStalledCount: 2,
    },
  );

  worker.on("completed", (job, result) => {
    if (result?.skipped) {
      console.log(`⏭️  SKIPPED: ${job.data.countryName} (already complete)`);
    } else {
      stats.completed++;
      console.log(`✅ DONE: ${job.data.countryName}`);
    }
    printStats();
  });

  worker.on("failed", (job, err) => {
    stats.failed++;
    console.error(
      `❌ FAILED: ${job?.data?.countryName} — ${err.message} (attempt ${job?.attemptsMade})`,
    );
  });

  worker.on("error", (err) => {
    console.error("❌ Country worker error:", err.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`⚠️ Country job stalled: ${jobId}`);
  });

  process.on("SIGTERM", async () => {
    console.log("⛔ SIGTERM — closing country worker gracefully");
    await worker.close();
  });

  return worker;
}

module.exports = { initCountryEnrichmentWorker };
