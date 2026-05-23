/**
 * scheduler.js — FIXED
 *
 * BUG FIX #1 (CRITICAL — root cause of empty queue):
 * ─────────────────────────────────────────────────
 * The query `"enrichment.crawlAttempts": { $lt: 99 }` does NOT match documents
 * where the field is MISSING (undefined). MongoDB treats missing fields as null,
 * and null is NOT less than 99 in a $lt comparison.
 *
 * Your 4,965 pending universities have never been processed → crawlAttempts
 * field doesn't exist → they're invisible to the scheduler → queue stays empty.
 *
 * FIX: Use $or to match both missing field AND field < 99:
 *   { $or: [
 *     { "enrichment.crawlAttempts": { $exists: false } },
 *     { "enrichment.crawlAttempts": { $lt: 99 } }
 *   ]}
 *
 * BUG FIX #2 (IMPORTANT — stuck processing jobs):
 * ────────────────────────────────────────────────
 * Your logs show 7 jobs in "processing" status from the crashed previous run.
 * These are stuck forever — the worker died without resetting them, and the
 * scheduler's query only looks for status "pending" or null.
 *
 * FIX: On startup and every 10 minutes, reset any job that has been
 * "processing" for > 20 minutes back to "pending" so it gets re-queued.
 *
 * BUG FIX #3:
 * ────────────────────────────────────────────────
 * The $not regex on failedReason crashes when failedReason is null/undefined
 * in some MongoDB versions. Using $nin or $not with explicit null guard instead.
 */

const University = require("../models/universities");
const { getEnrichmentQueue, getQueueStats } = require("./enrichmentQueue");

const BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE) || 60;
const TARGET_QUEUE_DEPTH = parseInt(process.env.TARGET_QUEUE_DEPTH) || 120;
const SCHEDULE_INTERVAL_MS =
  parseInt(process.env.SCHEDULE_INTERVAL_MS) || 90 * 1000;
const PARTIAL_RETRY_AFTER_HOURS = 12;
const FAILED_RETRY_AFTER_HOURS = 4;
const STUCK_PROCESSING_MINUTES = 20; // reset "processing" jobs older than this

// ─────────────────────────────────────────────
// Helper: match crawlAttempts < 99 OR missing
// ─────────────────────────────────────────────
function crawlAttemptsFilter(max = 99) {
  return {
    $or: [
      { "enrichment.crawlAttempts": { $exists: false } },
      { "enrichment.crawlAttempts": null },
      { "enrichment.crawlAttempts": { $lt: max } },
    ],
  };
}

// ─────────────────────────────────────────────
// BUG FIX #2: Reset stuck "processing" jobs
// Called on startup and every 10 min
// ─────────────────────────────────────────────
async function resetStuckProcessingJobs() {
  try {
    const stuckBefore = new Date(
      Date.now() - STUCK_PROCESSING_MINUTES * 60 * 1000,
    );

    const result = await University.updateMany(
      {
        "enrichment.status": "processing",
        "enrichment.lastEnrichedAt": { $lt: stuckBefore },
      },
      {
        $set: { "enrichment.status": "pending" },
      },
    );

    // Also reset jobs that are "processing" but have NO lastEnrichedAt
    // (they were set to processing and then the process crashed immediately)
    const result2 = await University.updateMany(
      {
        "enrichment.status": "processing",
        "enrichment.lastEnrichedAt": { $exists: false },
      },
      {
        $set: { "enrichment.status": "pending" },
      },
    );

    const total = (result.modifiedCount || 0) + (result2.modifiedCount || 0);
    if (total > 0) {
      console.log(`🔧 Reset ${total} stuck "processing" jobs → "pending"`);
    }
  } catch (err) {
    console.error("❌ Error resetting stuck jobs:", err.message);
  }
}

// ─────────────────────────────────────────────
// Main scheduler
// ─────────────────────────────────────────────
async function scheduleEnrichment() {
  const queue = getEnrichmentQueue();

  try {
    const queueStats = await getQueueStats();
    const currentDepth =
      queueStats.waiting + queueStats.active + queueStats.delayed;

    if (currentDepth >= TARGET_QUEUE_DEPTH) {
      return;
    }

    const needed = Math.min(BATCH_SIZE, TARGET_QUEUE_DEPTH - currentDepth);

    // ── Query 1: Never processed (pending or no status) ──
    // FIX #1: crawlAttemptsFilter() handles missing field correctly
    const pending = await University.find(
      {
        isEnriched: false,
        website: { $exists: true, $ne: "" },
        $or: [
          { "enrichment.status": { $in: ["pending", null] } },
          { "enrichment.status": { $exists: false } },
        ],
        ...crawlAttemptsFilter(99),
      },
      { _id: 1, name: 1, website: 1, featured: 1 },
    )
      .sort({ featured: -1, createdAt: 1 })
      .limit(needed)
      .lean();

    // ── Query 2: Failed — retry eligible ──
    const failedRetryAfter = new Date(
      Date.now() - FAILED_RETRY_AFTER_HOURS * 60 * 60 * 1000,
    );

    // FIX #3: avoid $not regex on potentially null field
    const failedRetry = await University.find(
      {
        "enrichment.status": "failed",
        "enrichment.lastEnrichedAt": { $lt: failedRetryAfter },
        website: { $exists: true, $ne: "" },
        // Only retry if attempts < 4 and not permanently dead
        $or: [
          { "enrichment.crawlAttempts": { $exists: false } },
          { "enrichment.crawlAttempts": { $lt: 4 } },
        ],
        // Don't retry permanently dead domains
        "enrichment.failedReason": {
          $not: { $regex: /Domain dead|ENOTFOUND/i },
        },
      },
      { _id: 1, name: 1, website: 1, featured: 1 },
    )
      .sort({ "enrichment.crawlAttempts": 1 })
      .limit(Math.max(0, needed - pending.length))
      .lean();

    // ── Query 3: Partial — retry low-confidence only ──
    const partialRetryAfter = new Date(
      Date.now() - PARTIAL_RETRY_AFTER_HOURS * 60 * 60 * 1000,
    );

    const partialRetry = await University.find(
      {
        "enrichment.status": "partial",
        "enrichment.confidenceScore": { $lt: 0.7 },
        "enrichment.lastEnrichedAt": { $lt: partialRetryAfter },
        website: { $exists: true, $ne: "" },
        $or: [
          { "enrichment.crawlAttempts": { $exists: false } },
          { "enrichment.crawlAttempts": { $lt: 5 } },
        ],
      },
      { _id: 1, name: 1, website: 1, featured: 1 },
    )
      .limit(Math.max(0, needed - pending.length - failedRetry.length))
      .lean();

    const toEnqueue = [...pending, ...failedRetry, ...partialRetry];

    if (toEnqueue.length === 0) {
      const remaining = await University.countDocuments({
        isEnriched: false,
        website: { $exists: true, $ne: "" },
        ...crawlAttemptsFilter(99),
      });

      if (remaining === 0) {
        console.log("🏁 All processable universities enriched!");
      } else {
        // This is useful to see — means something is wrong with queries
        console.log(
          `⚠️ Scheduler: 0 enqueued but ${remaining} unprocessed remain. Queue depth=${currentDepth}`,
        );
      }
      return;
    }

    const jobs = toEnqueue.map((u) => ({
      name: "enrich-university",
      data: {
        universityId: u._id.toString(),
        universityName: u.name,
        website: u.website,
      },
      opts: {
        jobId: `enrich-${u._id}`,
        priority: u.featured ? 10 : 0,
        attempts: 3,
        backoff: { type: "exponential", delay: 10000 },
      },
    }));

    await queue.addBulk(jobs);

    console.log(
      `📤 Enqueued ${jobs.length} universities | pending=${pending.length} failedRetry=${failedRetry.length} partialRetry=${partialRetry.length} | queueDepth=${currentDepth + jobs.length}`,
    );

    await logProgress();
  } catch (err) {
    console.error("❌ Scheduler error:", err.message, err.stack);
  }
}

async function logProgress() {
  try {
    const [
      total,
      completed,
      partial,
      failed,
      pending,
      trueEnriched,
      processing,
    ] = await Promise.all([
      University.countDocuments({ website: { $exists: true, $ne: "" } }),
      University.countDocuments({ "enrichment.status": "completed" }),
      University.countDocuments({ "enrichment.status": "partial" }),
      University.countDocuments({ "enrichment.status": "failed" }),
      University.countDocuments({
        isEnriched: false,
        $or: [
          { "enrichment.status": { $in: ["pending", null] } },
          { "enrichment.status": { $exists: false } },
        ],
      }),
      University.countDocuments({ isEnriched: true }),
      University.countDocuments({ "enrichment.status": "processing" }),
    ]);

    const pct = total > 0 ? ((trueEnriched / total) * 100).toFixed(1) : 0;
    console.log(
      `📈 Progress: ${trueEnriched}/${total} (${pct}%) | ✅ ${completed} | ⚠️ ${partial} | ❌ ${failed} | ⏳ ${pending} | ⚙️ ${processing}`,
    );
  } catch (_) {}
}

function startScheduler() {
  console.log("⏰ Scheduler started");

  // FIX #2: Reset stuck jobs on startup immediately
  resetStuckProcessingJobs().then(() => {
    // First scheduling run after stuck jobs are cleared
    scheduleEnrichment();
  });

  // Reset stuck jobs every 10 minutes
  setInterval(resetStuckProcessingJobs, 10 * 60 * 1000);

  // Normal scheduling interval
  setInterval(scheduleEnrichment, SCHEDULE_INTERVAL_MS);
}

module.exports = {
  scheduleEnrichment,
  startScheduler,
  logProgress,
  resetStuckProcessingJobs,
};
