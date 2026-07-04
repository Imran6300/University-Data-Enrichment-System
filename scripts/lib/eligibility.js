/**
 * eligibility.js
 *
 * Single source of truth for "which universities count as eligible for
 * relationship-graph matching" — the same bar sitemapController's
 * university filter uses. Originally declared only inside
 * relationship-backfill.js; pulled out into its own side-effect-free
 * module so scripts/unmatched-program-report.js (Phase 5) can reuse it
 * exactly instead of re-declaring a second copy that could silently
 * drift out of sync.
 *
 * IMPORTANT: this file must stay side-effect-free (no top-level
 * process.exit, no CLI arg parsing) since it's `require()`d by more than
 * one entry-point script.
 */

const ELIGIBILITY_FILTER = {
  $or: [
    { "enrichment.status": "completed" },
    { isEnriched: true },
    {
      $expr: {
        $gte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 300],
      },
    },
  ],
  country: { $exists: true, $ne: null },
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { ELIGIBILITY_FILTER, escapeRegex };
