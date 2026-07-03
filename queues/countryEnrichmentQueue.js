/**
 * countryEnrichmentQueue.js
 *
 * PHASE 4 (2026-07): country content enrichment, migrated from the
 * standalone services/scripts/enrichCountries.js (sequential loop, single
 * AI provider, no queue/retry infra) onto the same BullMQ infrastructure
 * as university enrichment. Mirrors enrichmentQueue.js's pattern exactly
 * so the two queues behave consistently (same connection helper, same
 * retention/backoff shape).
 */

const { Queue } = require("bullmq");
const { getBullMQConnection } = require("../utils/redis");

const QUEUE_NAME = "country-enrichment";
let countryEnrichmentQueue = null;

function getCountryEnrichmentQueue() {
  if (!countryEnrichmentQueue) {
    countryEnrichmentQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 10000,
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

    countryEnrichmentQueue.on("error", (err) => {
      console.error("❌ Country queue error:", err.message);
    });
  }
  return countryEnrichmentQueue;
}

async function enqueueCountry(countryId, countryName, options = {}) {
  const queue = getCountryEnrichmentQueue();
  return queue.add(
    "enrich-country",
    { countryId, countryName },
    {
      priority: options.priority || 0,
      jobId: `enrich-country-${countryId}`,
    },
  );
}

async function enqueueBatch(countries) {
  const queue = getCountryEnrichmentQueue();
  const jobs = countries.map((c) => ({
    name: "enrich-country",
    data: {
      countryId: c._id.toString(),
      countryName: c.name,
    },
    opts: {
      jobId: `enrich-country-${c._id}`,
      priority: c.featured ? 10 : 0,
    },
  }));
  return queue.addBulk(jobs);
}

async function getQueueStats() {
  const queue = getCountryEnrichmentQueue();
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
  return getCountryEnrichmentQueue().pause();
}

async function resumeQueue() {
  return getCountryEnrichmentQueue().resume();
}

async function clearFailedJobs() {
  const queue = getCountryEnrichmentQueue();
  return queue.clean(0, 1000, "failed");
}

module.exports = {
  getCountryEnrichmentQueue,
  enqueueCountry,
  enqueueBatch,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  clearFailedJobs,
  QUEUE_NAME,
};
