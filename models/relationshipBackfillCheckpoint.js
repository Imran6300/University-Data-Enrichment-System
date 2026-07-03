const mongoose = require("mongoose");

/**
 * RelationshipBackfillCheckpoint
 *
 * One document per distinct backfill "scope" (--all / --country X /
 * --course Y / --university Z). Updated periodically while the worker
 * runs so that `node scripts/relationship-backfill.js --resume` can pick
 * up exactly where a previous run left off — including after a crash,
 * a manual Ctrl+C, or an Oracle VM restart.
 *
 * `runKey` is a deterministic signature of the scope (e.g. "all",
 * "country:canada", "course:mba", "university:oxford") — NOT of the
 * whole CLI invocation, so re-running the same scope with a different
 * --parallel value still resumes correctly.
 */
const RelationshipBackfillCheckpointSchema = new mongoose.Schema(
  {
    runKey: { type: String, required: true, unique: true, index: true },

    mode: {
      type: String,
      enum: ["all", "country", "course", "university"],
      required: true,
    },
    scopeValue: { type: String, default: null }, // slug, if mode isn't "all"

    status: {
      type: String,
      enum: ["running", "paused", "completed", "failed"],
      default: "running",
    },

    // Cursor position — universities are processed in _id ascending order,
    // so resuming is just "resume where _id > lastProcessedId".
    lastProcessedId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Running totals across the whole scope (persist across resumes).
    totalInScope: { type: Number, default: 0 },
    processedCount: { type: Number, default: 0 },
    matchedCourseLinks: { type: Number, default: 0 },
    unmatchedPrograms: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },

    dryRun: { type: Boolean, default: false },

    startedAt: { type: Date, default: Date.now },
    lastCheckpointAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },

    // Freeform trail of recent errors, capped, for post-mortem without
    // needing to grep worker logs.
    recentErrors: [
      {
        universityId: mongoose.Schema.Types.ObjectId,
        universityName: String,
        message: String,
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "RelationshipBackfillCheckpoint",
  RelationshipBackfillCheckpointSchema,
);
