/**
 * courseScheduler.js
 *
 * PHASE 5b (2026-07): periodically finds Course documents that are both
 * (a) "high quality" — proven to have real demand by the relationship
 *     graph, not just freshly seeded and unlinked or a false-positive
 *     text-search match — and (b) missing core content fields, then
 *     enqueues them onto the course-enrichment queue.
 *
 * WHY THE QUALITY GATE: Course records created by
 * overseasbackend/scripts/seedPhase5Courses.js start with zero
 * university links until scripts/relationship-backfill.js runs against
 * them. Enriching a course with AI content before we know the backfill
 * actually found real demand for it would burn AI budget on courses that
 * might turn out to be near-empty (or worse, a false-positive text-match
 * bleeding across similar categories — e.g. Arts / Fine Arts / Liberal
 * Arts). So this scheduler only enqueues courses with
 * topUniversities.length >= COURSE_MIN_UNIVERSITY_LINKS, i.e. the
 * backfill has already proven real, multi-university demand for that
 * course before we spend an AI call describing it.
 *
 * This is a NEW quality concept the country/university schedulers don't
 * need (countries and universities aren't created programmatically from
 * a text-match process the way these new Course records are).
 */

const Course = require("../models/courses");
const {
  getCourseEnrichmentQueue,
  enqueueBatch,
  getQueueStats,
} = require("./courseEnrichmentQueue");

const BATCH_SIZE = parseInt(process.env.COURSE_SCHEDULER_BATCH_SIZE) || 20;
const TARGET_QUEUE_DEPTH =
  parseInt(process.env.COURSE_TARGET_QUEUE_DEPTH) || 40;
const SCHEDULE_INTERVAL_MS =
  parseInt(process.env.COURSE_SCHEDULE_INTERVAL_MS) || 5 * 60 * 1000;

// "High quality" = the relationship-backfill has already linked this
// course to at least this many real universities. Default 3 — low
// enough not to starve legitimately smaller fields, high enough to
// filter out near-zero-demand / likely-false-positive matches.
const MIN_UNIVERSITY_LINKS =
  parseInt(process.env.COURSE_MIN_UNIVERSITY_LINKS) || 3;

function highQualityIncompleteCourseFilter() {
  return {
    $expr: {
      $gte: [
        { $size: { $ifNull: ["$topUniversities", []] } },
        MIN_UNIVERSITY_LINKS,
      ],
    },
    $or: [
      { subtitle: { $in: [null, ""] } },
      { overviewTitle: { $in: [null, ""] } },
      { overviewDescription: { $in: [null, ""] } },
      { keyHighlights: { $size: 0 } },
      { entryRequirements: { $size: 0 } },
      { careerProspects: { $in: [null, ""] } },
      { popularJobRoles: { $size: 0 } },
      { salaryExpectations: { $in: [null, ""] } },
      { faqs: { $size: 0 } },
    ],
  };
}

async function fillQueue() {
  const stats = await getQueueStats();
  const spaceAvailable = TARGET_QUEUE_DEPTH - stats.total;

  if (spaceAvailable <= 0) {
    console.log(
      `📚 Course queue at target depth (${stats.total}/${TARGET_QUEUE_DEPTH}) — skipping this cycle`,
    );
    return;
  }

  const batchSize = Math.min(BATCH_SIZE, spaceAvailable);

  const courses = await Course.find(highQualityIncompleteCourseFilter())
    .select("_id title field level featured topUniversities")
    .limit(batchSize)
    .lean();

  if (courses.length === 0) {
    console.log(
      `📚 No high-quality courses (>= ${MIN_UNIVERSITY_LINKS} linked universities) currently need content enrichment.`,
    );
    return;
  }

  await enqueueBatch(courses);
  console.log(
    `📚 Enqueued ${courses.length} high-quality courses for content enrichment.`,
  );
}

function startCourseScheduler() {
  console.log(
    `📚 Course scheduler starting: batch=${BATCH_SIZE} targetDepth=${TARGET_QUEUE_DEPTH} ` +
      `minUniversityLinks=${MIN_UNIVERSITY_LINKS} interval=${SCHEDULE_INTERVAL_MS / 1000}s`,
  );

  fillQueue().catch((err) =>
    console.error("❌ Course scheduler initial run failed:", err.message),
  );

  const interval = setInterval(() => {
    fillQueue().catch((err) =>
      console.error("❌ Course scheduler cycle failed:", err.message),
    );
  }, SCHEDULE_INTERVAL_MS);

  return () => clearInterval(interval);
}

module.exports = { startCourseScheduler, fillQueue };
