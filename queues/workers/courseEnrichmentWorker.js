/**
 * courseEnrichmentWorker.js
 *
 * PHASE 5b (2026-07): BullMQ worker for course content enrichment. Same
 * job-handling shape as countryEnrichmentWorker.js (timeout race,
 * graceful shutdown) — third enrichment worker in this repo, same
 * pattern as the other two.
 *
 * SCOPE, DELIBERATELY NARROW: this worker ONLY writes subtitle,
 * overviewTitle, overviewDescription, keyHighlights, entryRequirements,
 * careerProspects, popularJobRoles, salaryExpectations, and faqs. It
 * does NOT touch topUniversities or countries — those ObjectId ref
 * arrays are owned exclusively by relationshipGraph.js (Phase 2), same
 * field-ownership rule as the country worker.
 *
 * It also does NOT touch seo.noIndex. Course.seo.noIndex is set to true
 * at creation time (see overseasbackend/scripts/seedPhase5Courses.js)
 * specifically so a human reviews relationship-backfill link quality
 * before a course goes live — this worker filling in content is a
 * separate concern from that go-live decision, so it deliberately leaves
 * noIndex alone. Flip it manually once you're satisfied with both the
 * content AND the linked-university quality.
 *
 * Like the country worker, this only fills fields that are currently
 * EMPTY — it never overwrites existing content.
 */

const { Worker } = require("bullmq");
const { QUEUE_NAME } = require("../courseEnrichmentQueue");
const { getBullMQConnection } = require("../../utils/redis");

const Course = require("../../models/courses");
const { extractCourseData } = require("../../ai/extractCourseData");

const WORKER_CONCURRENCY = parseInt(process.env.COURSE_WORKER_CONCURRENCY) || 2;
const PER_JOB_TIMEOUT_MS =
  parseInt(process.env.COURSE_JOB_TIMEOUT_MS) || 3 * 60 * 1000;
const LOCK_DURATION_MS = 5 * 60 * 1000;
const JOB_THROTTLE_MS = parseInt(process.env.COURSE_JOB_THROTTLE_MS) || 1500;

const stats = { completed: 0, failed: 0, retries: 0 };

function printStats() {
  console.log(
    `📊 Course stats: completed=${stats.completed} failed=${stats.failed} retries=${stats.retries}`,
  );
}

function isEmpty(val) {
  if (Array.isArray(val)) return val.length === 0;
  return !val || (typeof val === "string" && val.trim().length === 0);
}

// ─────────────────────────────────────────────
// Per-course processing
// ─────────────────────────────────────────────
async function processCourse(courseId, courseTitle) {
  const course = await Course.findById(courseId);
  if (!course) {
    return { success: false, reason: "Course not found" };
  }

  const needsEnrichment =
    isEmpty(course.subtitle) ||
    isEmpty(course.overviewTitle) ||
    isEmpty(course.overviewDescription) ||
    isEmpty(course.keyHighlights) ||
    isEmpty(course.entryRequirements) ||
    isEmpty(course.careerProspects) ||
    isEmpty(course.popularJobRoles) ||
    isEmpty(course.salaryExpectations) ||
    isEmpty(course.faqs);

  if (!needsEnrichment) {
    console.log(`⏭️  [${courseTitle}] Already fully enriched — skipping`);
    return { success: true, skipped: true };
  }

  const parsed = await extractCourseData({
    title: course.title,
    field: course.field,
    level: course.level,
  });

  const update = {};
  if (isEmpty(course.subtitle)) update.subtitle = parsed.subtitle;
  if (isEmpty(course.overviewTitle))
    update.overviewTitle = parsed.overviewTitle;
  if (isEmpty(course.overviewDescription))
    update.overviewDescription = parsed.overviewDescription;
  if (isEmpty(course.keyHighlights))
    update.keyHighlights = parsed.keyHighlights;
  if (isEmpty(course.entryRequirements))
    update.entryRequirements = parsed.entryRequirements;
  if (isEmpty(course.careerProspects))
    update.careerProspects = parsed.careerProspects;
  if (isEmpty(course.popularJobRoles))
    update.popularJobRoles = parsed.popularJobRoles;
  if (isEmpty(course.salaryExpectations))
    update.salaryExpectations = parsed.salaryExpectations;
  if (isEmpty(course.faqs)) update.faqs = parsed.faqs;

  if (Object.keys(update).length === 0) {
    return { success: true, skipped: true };
  }

  update.seoLastReviewedAt = new Date();

  await Course.findByIdAndUpdate(courseId, update, { runValidators: true });

  console.log(
    `💾 [${courseTitle}] Saved (${Object.keys(update).join(", ")}) via ${parsed._model}`,
  );

  return { success: true, fieldsUpdated: Object.keys(update) };
}

// ─────────────────────────────────────────────
// Worker initialization
// ─────────────────────────────────────────────
function initCourseEnrichmentWorker() {
  console.log(
    `👷 Course enrichment worker: concurrency=${WORKER_CONCURRENCY} | timeout=${PER_JOB_TIMEOUT_MS / 60000}min`,
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (JOB_THROTTLE_MS > 0) {
        await new Promise((r) => setTimeout(r, JOB_THROTTLE_MS));
      }

      if (job.attemptsMade > 0) stats.retries++;

      const { courseId, courseTitle } = job.data;
      console.log(
        `\n🚀 [${courseTitle}] Starting course enrichment (attempt ${job.attemptsMade + 1})`,
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

      return Promise.race([processCourse(courseId, courseTitle), jobTimeout]);
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
      console.log(`⏭️  SKIPPED: ${job.data.courseTitle} (already complete)`);
    } else {
      stats.completed++;
      console.log(`✅ DONE: ${job.data.courseTitle}`);
    }
    printStats();
  });

  worker.on("failed", (job, err) => {
    stats.failed++;
    console.error(
      `❌ FAILED: ${job?.data?.courseTitle} — ${err.message} (attempt ${job?.attemptsMade})`,
    );
  });

  worker.on("error", (err) => {
    console.error("❌ Course worker error:", err.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`⚠️ Course job stalled: ${jobId}`);
  });

  process.on("SIGTERM", async () => {
    console.log("⛔ SIGTERM — closing course worker gracefully");
    await worker.close();
  });

  return worker;
}

module.exports = { initCourseEnrichmentWorker };
