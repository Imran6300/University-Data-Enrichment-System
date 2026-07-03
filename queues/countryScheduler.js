/**
 * countryScheduler.js
 *
 * PHASE 4 (2026-07): periodically finds countries missing
 * careerOpportunities/scholarships/eligibilityRequirements/whyStudyCards
 * and enqueues them onto the country-enrichment queue. Replaces the
 * one-shot "run the script manually" workflow of the old
 * services/scripts/enrichCountries.js.
 */

const Country = require("../models/countries");
const {
  getCountryEnrichmentQueue,
  enqueueBatch,
  getQueueStats,
} = require("./countryEnrichmentQueue");

const BATCH_SIZE = parseInt(process.env.COUNTRY_SCHEDULER_BATCH_SIZE) || 20;
const TARGET_QUEUE_DEPTH =
  parseInt(process.env.COUNTRY_TARGET_QUEUE_DEPTH) || 40;
const SCHEDULE_INTERVAL_MS =
  parseInt(process.env.COUNTRY_SCHEDULE_INTERVAL_MS) || 5 * 60 * 1000;

function incompleteCountryFilter() {
  return {
    $or: [
      { careerOpportunities: { $size: 0 } },
      { scholarships: { $size: 0 } },
      { eligibilityRequirements: { $size: 0 } },
      { whyStudyCards: { $size: 0 } },
    ],
  };
}

async function fillQueue() {
  const stats = await getQueueStats();
  const spaceAvailable = TARGET_QUEUE_DEPTH - stats.total;

  if (spaceAvailable <= 0) {
    console.log(
      `🌍 Country queue at target depth (${stats.total}/${TARGET_QUEUE_DEPTH}) — skipping this cycle`,
    );
    return;
  }

  const batchSize = Math.min(BATCH_SIZE, spaceAvailable);

  const countries = await Country.find(incompleteCountryFilter())
    .select("_id name featured")
    .limit(batchSize)
    .lean();

  if (countries.length === 0) {
    console.log("🌍 No countries currently need content enrichment.");
    return;
  }

  await enqueueBatch(countries);
  console.log(
    `🌍 Enqueued ${countries.length} countries for content enrichment.`,
  );
}

function startCountryScheduler() {
  console.log(
    `🌍 Country scheduler starting: batch=${BATCH_SIZE} targetDepth=${TARGET_QUEUE_DEPTH} interval=${SCHEDULE_INTERVAL_MS / 1000}s`,
  );

  fillQueue().catch((err) =>
    console.error("❌ Country scheduler initial run failed:", err.message),
  );

  const interval = setInterval(() => {
    fillQueue().catch((err) =>
      console.error("❌ Country scheduler cycle failed:", err.message),
    );
  }, SCHEDULE_INTERVAL_MS);

  return () => clearInterval(interval);
}

module.exports = { startCountryScheduler, fillQueue };
