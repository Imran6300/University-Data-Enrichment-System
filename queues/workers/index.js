const { initEnrichmentWorker } = require("../workers/enrichmentWorker");
const {
  initCountryEnrichmentWorker,
} = require("../workers/countryEnrichmentWorker");
const {
  initCourseEnrichmentWorker,
} = require("../workers/courseEnrichmentWorker");

function initWorkers() {
  initEnrichmentWorker();
  initCountryEnrichmentWorker();
  initCourseEnrichmentWorker();
}

module.exports = { initWorkers };
