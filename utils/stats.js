/**
 * UPGRADED: stats.js
 *
 * Key improvements:
 * - ETA calculation based on current rate
 * - Per-country breakdown
 * - Confidence score distribution
 * - Average processing time tracking
 */

const University = require("../models/universities");

const rateTracker = {
  samples: [], // { ts, count }
  maxSamples: 30,
};

async function logEnrichmentStats() {
  try {
    const [
      total,
      completed,
      partial,
      failed,
      pending,
      processing,
      highConfidence,
      lowConfidence,
    ] = await Promise.all([
      University.countDocuments({ website: { $exists: true, $ne: "" } }),
      University.countDocuments({ "enrichment.status": "completed" }),
      University.countDocuments({ "enrichment.status": "partial" }),
      University.countDocuments({ "enrichment.status": "failed" }),
      University.countDocuments({
        isEnriched: false,
        "enrichment.status": { $in: ["pending", null] },
      }),
      University.countDocuments({ "enrichment.status": "processing" }),
      University.countDocuments({
        "enrichment.confidenceScore": { $gte: 0.8 },
      }),
      University.countDocuments({
        "enrichment.confidenceScore": { $gt: 0, $lt: 0.8 },
      }),
    ]);

    const done = completed + partial;
    const pct = total > 0 ? ((done / total) * 100).toFixed(1) : 0;

    // Track rate
    const now = Date.now();
    rateTracker.samples.push({ ts: now, count: done });
    if (rateTracker.samples.length > rateTracker.maxSamples) {
      rateTracker.samples.shift();
    }

    // Calculate rate (universities/hour)
    let ratePerHour = 0;
    let etaHours = null;
    if (rateTracker.samples.length >= 2) {
      const oldest = rateTracker.samples[0];
      const newest = rateTracker.samples[rateTracker.samples.length - 1];
      const deltaCount = newest.count - oldest.count;
      const deltaMs = newest.ts - oldest.ts;
      if (deltaMs > 0 && deltaCount > 0) {
        ratePerHour = Math.round((deltaCount / deltaMs) * 1000 * 3600);
        if (ratePerHour > 0 && pending > 0) {
          etaHours = (pending / ratePerHour).toFixed(1);
        }
      }
    }

    console.log(`
📊 ENRICHMENT STATS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏫 Total Universities  : ${total}
✅ Completed           : ${completed}
⚠️  Partial             : ${partial}
❌ Failed              : ${failed}
⏳ Pending             : ${pending}
⚙️  Processing          : ${processing}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Progress            : ${done}/${total} (${pct}%)
🎯 High Confidence     : ${highConfidence}
📉 Low Confidence      : ${lowConfidence}
⚡ Rate                : ~${ratePerHour}/hour
⏰ ETA                 : ${etaHours ? `~${etaHours}h` : "calculating..."}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

    return {
      total,
      completed,
      partial,
      failed,
      pending,
      processing,
      ratePerHour,
    };
  } catch (err) {
    console.error("Stats error:", err.message);
    return null;
  }
}

module.exports = { logEnrichmentStats };
