/**
 * countryExtractionPrompt.js
 *
 * PHASE 4 (2026-07): country content generation prompt, migrated from
 * services/scripts/enrichCountries.js.
 *
 * DELIBERATELY SCOPED: only asks for careerOpportunities, scholarships,
 * eligibilityRequirements, whyStudyCards — plain-text/subdocument fields
 * on the Country schema. It does NOT ask for topUniversities or
 * popularCourses.
 *
 * Why: those two fields are `ObjectId` reference arrays
 * (ref: "University" / ref: "Course") on the Country schema. The old
 * script asked the AI to invent university/course NAMES as strings and
 * tried to save them directly into those ref fields — which Mongoose
 * cannot cast, so it was failing on every save (confirmed while auditing
 * this migration). Those fields are correctly owned by
 * relationshipGraph.js (Phase 2), which links REAL University/Course
 * documents rather than hallucinated names. AI content generation and
 * relationship-graph linking are two different concerns and shouldn't
 * both be writing to the same two fields.
 */

const EXTRACTION_SYSTEM_PROMPT = `You are a study-abroad content engine. Generate accurate, SEO-friendly, student-focused content about studying in a specific country. Return ONLY raw valid JSON — no markdown, no \`\`\`json fences, no prose, no explanations.`;

function buildCountryExtractionPrompt(countryName) {
  return `Generate study-abroad information for international students considering ${countryName}.

Return ONLY valid JSON in this exact shape:
{
  "careerOpportunities": ["...", "..."],
  "scholarships": ["...", "..."],
  "eligibilityRequirements": ["...", "..."],
  "whyStudyCards": [
    { "title": "...", "description": "..." }
  ]
}

Rules:
- No markdown, no explanations, no extra keys.
- SEO friendly, student focused, concise, realistic.
- Do NOT invent specific university names or specific course/program names —
  those come from this platform's own database, not from you.
- careerOpportunities: general career paths/industries graduates in ${countryName} pursue (not tied to one program).
- scholarships: real, well-known scholarship PROGRAMS or TYPES available to international students in ${countryName}
  (e.g. government-funded schemes, university-wide need/merit-based aid categories) — describe the type/name
  generically if you're not certain of an exact current program, don't fabricate specific amounts or deadlines.
- eligibilityRequirements: general admission/visa eligibility expectations for international students in ${countryName}.
- whyStudyCards: minimum 3 cards, each with a short title and a 1-2 sentence description.
- Minimum: 5 careerOpportunities, 4 scholarships, 5 eligibilityRequirements, 3 whyStudyCards.`;
}

module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  buildCountryExtractionPrompt,
};
