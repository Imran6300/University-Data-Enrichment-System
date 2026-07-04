/**
 * seoPerformanceSnapshot.js
 *
 * PHASE 7c: durable storage for Google Search Console Pages/Queries
 * performance pulls, so before/after CTR comparisons don't depend on
 * someone remembering to keep a CSV export around.
 *
 * Same durable-persistence discipline established in Phase 5 after the
 * unmatched-programs data-loss incident: write pulls to Mongo (not just
 * console output), one document per run, so every run against every
 * page is diffable against every prior run.
 *
 * One document per (runLabel, url) pair rather than one giant document
 * per run — keeps individual writes small and makes per-URL time-series
 * queries a simple indexed find() instead of unpacking a huge array.
 */

const mongoose = require("mongoose");

const SeoPerformanceSnapshotSchema = new mongoose.Schema(
  {
    // Human/machine label for this pull, e.g. "2026-07-04" or
    // "run-zero" for the original 3-month baseline export referenced in
    // the Phase 7 brief (Section 2, 7c) — that baseline is legitimate
    // "before" data for pages this phase touches and should be loaded
    // once via --seed-baseline rather than discarded.
    runLabel: { type: String, required: true, index: true },
    runDate: { type: Date, required: true, default: Date.now },

    url: { type: String, required: true, index: true },

    // Raw GSC Search Analytics metrics for this URL over the query
    // window (see gsc_ctr_tracker.js for window length).
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }, // 0-1, as returned by GSC
    position: { type: Number, default: 0 },

    // Populated by gsc_ctr_tracker.js by matching the URL back to a
    // Country/Course/University slug, so runs can be filtered to "just
    // the pages 7b touched" instead of site-wide noise.
    entityType: {
      type: String,
      enum: ["country", "course", "university", "blog", "combo", "other"],
      default: "other",
    },
    slug: { type: String },

    // Set true once generate_seo_meta.js has rewritten this URL's
    // title/description — lets later runs diff specifically against
    // "pages we touched" rather than the whole site.
    metaRewritten: { type: Boolean, default: false },
    metaRewrittenAt: { type: Date },
  },
  { timestamps: true },
);

SeoPerformanceSnapshotSchema.index({ url: 1, runLabel: 1 }, { unique: true });
SeoPerformanceSnapshotSchema.index({ entityType: 1, runDate: -1 });

module.exports = mongoose.model(
  "SeoPerformanceSnapshot",
  SeoPerformanceSnapshotSchema,
);
