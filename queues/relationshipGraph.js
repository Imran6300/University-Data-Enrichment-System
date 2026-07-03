/**
 * relationshipGraph.js
 *
 * FIXES AUDIT FINDING #2 (Phase-0 architecture audit, 2026-07):
 *
 *   config/services/relationshipService.js is the ONLY code that populates
 *   Country.topUniversities / Country.popularCourses / Course.topUniversities
 *   / Course.countries — and it is only ever called from the admin CRUD
 *   controllers in config/. The autonomous enrichment worker in this repo
 *   (queues/) never touched `university.courses` at all, so every
 *   autonomously-enriched university (the large majority of the ~9,000
 *   university corpus) was "graph-orphaned": it could never appear in a
 *   country's topUniversities/popularCourses, never appear in a combo
 *   page's `universitiesInCountry` list, and never justify a
 *   study-{course}-in-{country} combo page actually having content.
 *
 * WHAT THIS MODULE DOES:
 *   1. Takes the AI-extracted `programs` array (e.g.
 *      [{ category: "Computer Science", level: "Postgraduate" }, ...])
 *      produced by extractUniversityData.js / ensureAllFields().
 *   2. Matches each program against EXISTING Course documents using the
 *      Course collection's text index (title/subtitle/field/...).
 *   3. Does NOT auto-create new Course documents. This is a deliberate,
 *      conservative choice: Course requires `title`, `duration`
 *      (both required in the schema) and a constrained `level` enum
 *      (Bachelor/Master/PhD/Diploma) that doesn't line up 1:1 with the
 *      inferred program levels (Undergraduate/Postgraduate/Diploma/
 *      Certificate) — auto-generating Course records from partial,
 *      sometimes-inferred program data risks the same "9,000 thin/
 *      low-relevance entities diluting topical authority" problem the
 *      audit flagged for universities (finding 2.5). Unmatched programs
 *      are logged so they can be reviewed and turned into real Course
 *      records deliberately (Phase 5 of the roadmap).
 *   4. For matched courses, updates `university.courses` and then syncs
 *      the relationship graph both directions:
 *        Country.topUniversities / Country.popularCourses
 *        Course.topUniversities / Course.countries
 *      — the same shape relationshipService.js already does for the
 *      admin-CRUD path, so both paths now keep the graph consistent.
 *
 * This module intentionally uses the LOCAL (queues/) Mongoose models,
 * since queues/ and config/ are separately deployed services that both
 * talk to the same MongoDB — there is no shared schema package yet
 * (that's Phase 3 of the roadmap). Once packages/schemas exists, this
 * file can import the shared models instead of queues/models/*.
 */

const University = require("../models/universities");
const Course = require("../models/courses");
const Country = require("../models/countries");

// Map the enrichment worker's inferred/extracted program levels onto the
// Course schema's constrained enum. "Certificate" has no clean equivalent —
// it's treated as Diploma, the closest tier.
const LEVEL_MAP = {
  Undergraduate: "Bachelor",
  Postgraduate: "Master",
  Doctorate: "PhD",
  PhD: "PhD",
  Diploma: "Diploma",
  Certificate: "Diploma",
};

const MATCH_SCORE_THRESHOLD = 1.0; // MongoDB $text relevance score floor

/**
 * Find an existing Course document that best matches an extracted program.
 * Uses the text index already defined on the Course schema
 * (title/subtitle/field/overviewDescription/popularJobRoles).
 *
 * @param {object} program - { category, level }
 * @param {string|null} restrictCourseId - if set, only consider this one
 *   Course document as a candidate (used by the backfill worker's
 *   `--course` scope, so a targeted run can't accidentally link
 *   unrelated courses).
 */
async function matchCourse(program, restrictCourseId = null) {
  const category = (program.category || "").trim();
  if (!category) return null;

  const mappedLevel = LEVEL_MAP[program.level] || null;

  if (restrictCourseId) {
    const course = await Course.findById(restrictCourseId)
      .select("_id title level countries")
      .lean();
    if (!course) return null;
    // Still require some textual relevance so we don't blindly link every
    // program on the university to the one course being targeted.
    const courseWords = (course.title || "").toLowerCase().split(/\s+/);
    const categoryWords = category.toLowerCase().split(/\s+/);
    const overlap = courseWords.some(
      (w) => w.length > 3 && categoryWords.includes(w),
    );
    return overlap ? course : null;
  }

  const textQuery = { $text: { $search: category } };
  const candidates = await Course.find(textQuery, {
    score: { $meta: "textScore" },
  })
    .sort({ score: { $meta: "textScore" } })
    .limit(5)
    .select("_id title level countries")
    .lean();

  if (!candidates.length) return null;

  // Prefer a candidate whose level also matches, if we have a mapped level
  // and more than one candidate cleared the text-relevance floor.
  const strong = candidates.filter(
    (c) => (c.score || 0) >= MATCH_SCORE_THRESHOLD,
  );
  const pool = strong.length ? strong : candidates;

  if (mappedLevel) {
    const levelMatch = pool.find((c) => c.level === mappedLevel);
    if (levelMatch) return levelMatch;
  }

  // Only accept a level-less match if the text relevance is strong —
  // otherwise we'd rather skip than mislink (e.g. "Business Administration"
  // program matching an unrelated "Business Analytics" course).
  return strong.length ? strong[0] : null;
}

/**
 * Match every extracted program to existing courses (best-effort, no
 * creation), returning the matched Course IDs plus a log of unmatched
 * programs for later manual review.
 */
async function matchProgramsToCourses(
  programs = [],
  { restrictCourseId = null } = {},
) {
  const matchedCourseIds = [];
  const unmatched = [];

  for (const program of programs) {
    try {
      const course = await matchCourse(program, restrictCourseId);
      if (course) {
        matchedCourseIds.push(course._id);
      } else {
        unmatched.push(program);
      }
    } catch (err) {
      // Text search can throw if MongoDB text index isn't available in
      // some environments — never let a matching failure fail enrichment.
      unmatched.push(program);
    }
  }

  return {
    courseIds: [...new Set(matchedCourseIds.map((id) => id.toString()))],
    unmatched,
  };
}

/**
 * Sync the relationship graph for one university, given its resolved
 * country and matched course IDs. Mirrors
 * config/services/relationshipService.syncUniversityRelationships, so both
 * the admin-CRUD path and the autonomous enrichment path keep the graph
 * consistent the same way.
 *
 * @param {boolean} dryRun - if true, compute nothing new to write (the
 *   caller already knows courseIds) but skip the actual DB writes. Used by
 *   the backfill worker's --dry-run flag.
 */
async function syncUniversityRelationships(
  universityId,
  countryId,
  courseIds,
  { dryRun = false } = {},
) {
  if (!countryId && (!courseIds || courseIds.length === 0)) return;
  if (dryRun) return;

  if (countryId) {
    await Country.findByIdAndUpdate(countryId, {
      $addToSet: {
        topUniversities: universityId,
        ...(courseIds.length ? { popularCourses: { $each: courseIds } } : {}),
      },
    });
  }

  if (courseIds.length) {
    await Course.updateMany(
      { _id: { $in: courseIds } },
      {
        $addToSet: {
          topUniversities: universityId,
          ...(countryId ? { countries: countryId } : {}),
        },
      },
    );
  }
}

/**
 * Main entry point, called by the enrichment worker after a university has
 * been saved, and by the relationship-backfill worker for retroactive runs.
 * Matches extracted programs to existing courses, updates
 * university.courses, and syncs the relationship graph.
 *
 * Safe to call even with an empty/missing programs array — it's a no-op
 * beyond logging in that case, so it can't break existing enrichment runs.
 *
 * @param {boolean} dryRun - compute matches and log them, but write nothing.
 * @param {string|null} restrictCourseId - see matchCourse() above.
 * @param {boolean} quiet - suppress the per-university console.log (the
 *   backfill worker does its own aggregate progress logging).
 */
async function reconcileUniversityGraph({
  universityId,
  universityName,
  countryId,
  programs,
  dryRun = false,
  restrictCourseId = null,
  quiet = false,
}) {
  const { courseIds, unmatched } = await matchProgramsToCourses(programs, {
    restrictCourseId,
  });

  if (courseIds.length > 0 && !dryRun) {
    await University.findByIdAndUpdate(universityId, {
      $addToSet: { courses: { $each: courseIds } },
    });
  }

  await syncUniversityRelationships(universityId, countryId, courseIds, {
    dryRun,
  });

  if (!quiet) {
    if (unmatched.length > 0) {
      console.log(
        `  🔗 [${universityName}] Graph sync: matched ${courseIds.length}/${programs.length} programs to existing courses. ` +
          `${unmatched.length} unmatched (no existing Course record — needs review): ` +
          `${unmatched
            .map((p) => p.category)
            .slice(0, 5)
            .join(", ")}${unmatched.length > 5 ? "…" : ""}`,
      );
    } else if (courseIds.length > 0) {
      console.log(
        `  🔗 [${universityName}] Graph sync: linked ${courseIds.length} course(s), relationship graph updated.`,
      );
    }
  }

  return { courseIds, unmatched };
}

module.exports = {
  reconcileUniversityGraph,
  matchProgramsToCourses,
  syncUniversityRelationships,
};
