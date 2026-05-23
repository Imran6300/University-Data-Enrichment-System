const { initEnrichmentWorker } = require("../workers/enrichmentWorker");

function initWorkers() {
  initEnrichmentWorker();
}

module.exports = { initWorkers };
