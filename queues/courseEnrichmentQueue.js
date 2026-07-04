/**
 * courseEnrichmentQueue.js
 *
 * PHASE 5b (2026-07): course content enrichment queue. Mirrors
 * countryEnrichmentQueue.js exactly (same connection helper, same
 * retention/backoff shape) so all three enrichment queues in this repo
 * (university / country / course) behave consistently.
 */

const { Queue } = require("bullmq");
const { getBullMQConnection } = require("../utils/redis");

const QUEUE_NAME = "course-enrichment";
let courseEnrichmentQueue = null;

function getCourseEnrichmentQueue() {
  if (!courseEnrichmentQueue) {
    courseEnrichmentQueue = new Queue(QUEUE_NAME, {
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

    courseEnrichmentQueue.on("error", (err) => {
      console.error("❌ Course queue error:", err.message);
    });
  }
  return courseEnrichmentQueue;
}

async function enqueueCourse(courseId, courseTitle, options = {}) {
  const queue = getCourseEnrichmentQueue();
  return queue.add(
    "enrich-course",
    { courseId, courseTitle },
    {
      priority: options.priority || 0,
      jobId: `enrich-course-${courseId}`,
    },
  );
}

async function enqueueBatch(courses) {
  const queue = getCourseEnrichmentQueue();
  const jobs = courses.map((c) => ({
    name: "enrich-course",
    data: {
      courseId: c._id.toString(),
      courseTitle: c.title,
      field: c.field,
      level: c.level,
    },
    opts: {
      jobId: `enrich-course-${c._id}`,
      priority: c.featured ? 10 : 0,
    },
  }));
  return queue.addBulk(jobs);
}

async function getQueueStats() {
  const queue = getCourseEnrichmentQueue();
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
  return getCourseEnrichmentQueue().pause();
}

async function resumeQueue() {
  return getCourseEnrichmentQueue().resume();
}

async function clearFailedJobs() {
  const queue = getCourseEnrichmentQueue();
  return queue.clean(0, 1000, "failed");
}

module.exports = {
  getCourseEnrichmentQueue,
  enqueueCourse,
  enqueueBatch,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  clearFailedJobs,
  QUEUE_NAME,
};
