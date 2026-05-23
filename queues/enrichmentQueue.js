/**
 * enrichmentQueue.js — FIXED
 *
 * CRITICAL FIX: Queue must use getBullMQConnection(), NOT getRedisConnection().
 *
 * The old code used getRedisConnection() which had commandTimeout: 5000ms.
 * BullMQ Queue internals (ZADD, LPUSH, Lua scripts) can take longer under load
 * → commandTimeout fires → "Command timed out" errors.
 *
 * Rate tuned for 500 universities/16 hours:
 * - 500 / 16h = ~31/hour = ~1 every 115 seconds
 * - With concurrency=4 and ~90s/university: ~160/hour theoretical max
 * - Safe with free AI models: concurrency=2–3, ~31/hour target
 */

const { Queue } = require("bullmq");
const { getBullMQConnection } = require("../utils/redis");

const QUEUE_NAME = "university-enrichment";
let enrichmentQueue = null;

function getEnrichmentQueue() {
  if (!enrichmentQueue) {
    enrichmentQueue = new Queue(QUEUE_NAME, {
      // MUST use BullMQ connection (no commandTimeout)
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 10000, // 10s → 20s → 40s
        },
        removeOnComplete: {
          count: 500,
          age: 48 * 3600,
        },
        removeOnFail: {
          count: 2000,
          age: 7 * 24 * 3600,
        },
      },
    });

    enrichmentQueue.on("error", (err) => {
      console.error("❌ Queue error:", err.message);
    });
  }
  return enrichmentQueue;
}

async function enqueueUniversity(
  universityId,
  universityName,
  website,
  options = {},
) {
  const queue = getEnrichmentQueue();
  return queue.add(
    "enrich-university",
    { universityId, universityName, website },
    {
      priority: options.priority || 0,
      jobId: `enrich-${universityId}`,
    },
  );
}

async function enqueueBatch(universities) {
  const queue = getEnrichmentQueue();
  const jobs = universities.map((u) => ({
    name: "enrich-university",
    data: {
      universityId: u._id.toString(),
      universityName: u.name,
      website: u.website,
    },
    opts: {
      jobId: `enrich-${u._id}`,
      priority: u.featured ? 10 : 0,
    },
  }));
  return queue.addBulk(jobs);
}

async function getQueueStats() {
  const queue = getEnrichmentQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

async function pauseQueue() {
  return getEnrichmentQueue().pause();
}

async function resumeQueue() {
  return getEnrichmentQueue().resume();
}

async function clearFailedJobs() {
  const queue = getEnrichmentQueue();
  return queue.clean(0, 1000, "failed");
}

module.exports = {
  getEnrichmentQueue,
  enqueueUniversity,
  enqueueBatch,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  clearFailedJobs,
  QUEUE_NAME,
};
