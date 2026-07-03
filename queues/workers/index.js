const { initEnrichmentWorker } = require("../workers/enrichmentWorker");
const {
  initCountryEnrichmentWorker,
} = require("../workers/countryEnrichmentWorker");

function initWorkers() {
  initEnrichmentWorker();
  initCountryEnrichmentWorker();
}

module.exports = { initWorkers };
