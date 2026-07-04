const mongoose = require("mongoose");

/**
 * UnmatchedProgramReport
 *
 * Phase 5 checkpoint fix: the Phase 2 relationship-backfill run produced a
 * "16,774 unmatched programs" figure that was only ever printed to a
 * terminal and never persisted anywhere — by the time Phase 5 started,
 * that list was gone and had to be assumed lost. This collection exists
 * so that never happens again: every run of
 * scripts/unmatched-program-report.js writes one document here (plus a
 * JSON file on disk, see outputFile) BEFORE any prioritization or
 * Course-creation decisions get made from it.
 *
 * One document per report run. `rankedCategories` is the actual Phase 5
 * input — extracted programs (grouped by normalized category text) that
 * matched no existing Course document, ranked by how many universities
 * offer something in that category, so new Course records can be
 * prioritized by real leverage instead of guesswork.
 */
const UnmatchedProgramReportSchema = new mongoose.Schema(
  {
    runKey: { type: String, required: true, unique: true, index: true },

    status: {
      type: String,
      enum: ["running", "paused", "completed", "failed"],
      default: "running",
    },

    // Same cursor-resume shape as RelationshipBackfillCheckpoint, so this
    // report generator survives a crash/Ctrl+C on the full ~9,000
    // university corpus without losing progress or double-counting.
    lastProcessedId: { type: mongoose.Schema.Types.ObjectId, default: null },

    totalUniversitiesInScope: { type: Number, default: 0 },
    universitiesScanned: { type: Number, default: 0 },
    totalProgramsScanned: { type: Number, default: 0 },
    totalMatched: { type: Number, default: 0 },
    totalUnmatched: { type: Number, default: 0 },
    uniqueUnmatchedCategories: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },

    // Ranked frequency list — sorted descending by `count` at completion.
    // This is what Phase 5 course-creation prioritization should read.
    rankedCategories: [
      {
        category: String, // normalized (lowercase, trimmed, collapsed whitespace)
        sampleLabel: String, // original casing as first encountered, for readability
        count: Number, // how many (university, program) pairs had this unmatched category
        universityCount: Number, // how many DISTINCT universities offered it
        levels: { type: Map, of: Number }, // extracted level -> count, e.g. {Postgraduate: 40, Undergraduate: 12}
        sampleUniversities: [String], // up to 8 sample university names, for spot-checking before creating a Course
      },
    ],

    // Absolute path to the raw (non-aggregated) JSON dump written to disk
    // alongside this document — every unmatched (university, program) pair,
    // untruncated, in case the aggregation logic itself needs revisiting.
    outputFile: { type: String, default: null },

    startedAt: { type: Date, default: Date.now },
    lastCheckpointAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "UnmatchedProgramReport",
  UnmatchedProgramReportSchema,
);
