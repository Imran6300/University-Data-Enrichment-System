/**
 * courseExtractionPrompt.js
 *
 * PHASE 5b (2026-07): course content generation, extending the same
 * pattern as countryExtractionPrompt.js (Phase 4) to the Course entity.
 *
 * DELIBERATELY SCOPED, same rule as country: only asks for plain-text/
 * subdocument fields on the Course schema (subtitle, overviewTitle,
 * overviewDescription, keyHighlights, entryRequirements, careerProspects,
 * popularJobRoles, salaryExpectations, faqs). It does NOT ask for
 * topUniversities or countries — those are ObjectId ref arrays owned
 * exclusively by relationshipGraph.js (Phase 2). AI content generation
 * and relationship-graph linking are different concerns; this file only
 * ever touches the former, same as the country pipeline.
 *
 * Also does NOT ask for fees / avgSalary / scholarships as hard numbers —
 * these vary enormously by country and university and a single AI call
 * per course (not per course×country) shouldn't be inventing currency
 * figures. Left for a future course×country-scoped enrichment pass if
 * ever needed; out of scope here.
 */

const EXTRACTION_SYSTEM_PROMPT = `You are a study-abroad content engine. Generate accurate, SEO-friendly, student-focused content about a specific academic program/course category. Return ONLY raw valid JSON — no markdown, no \`\`\`json fences, no prose, no explanations.`;

function buildCourseExtractionPrompt({ title, field, level }) {
  return `Generate study-abroad program information for international students considering a ${level}-level program in "${field}" (course: "${title}").

Return ONLY valid JSON in this exact shape:
{
  "subtitle": "...",
  "overviewTitle": "...",
  "overviewDescription": "...",
  "keyHighlights": ["...", "..."],
  "entryRequirements": [
    { "title": "...", "description": "..." }
  ],
  "careerProspects": "...",
  "popularJobRoles": ["...", "..."],
  "salaryExpectations": "...",
  "faqs": [
    { "question": "...", "answer": "..." }
  ]
}

Rules:
- No markdown, no explanations, no extra keys.
- SEO friendly, student focused, concise, realistic.
- Do NOT invent specific university names or specific country names —
  those come from this platform's own database, not from you.
- Do NOT invent specific currency figures, exact fee amounts, or exact
  salary numbers — describe ranges/relative terms only if needed
  (e.g. "competitive, varies significantly by country and university"),
  since a single generic write shouldn't fabricate precision it doesn't have.
- subtitle: one short (<=12 word) tagline for the program.
- overviewTitle: a short heading for the program overview section.
- overviewDescription: 3-5 sentences on what the program covers and who it's for.
- keyHighlights: minimum 4 short highlight bullets.
- entryRequirements: minimum 4 general admission requirement items typical
  for a ${level}-level program in this field internationally.
- careerProspects: 2-4 sentences on realistic career paths for graduates.
- popularJobRoles: minimum 5 realistic job titles graduates pursue.
- salaryExpectations: 1-2 sentences, relative/qualitative, no fabricated numbers.
- faqs: minimum 3 question/answer pairs a prospective international student
  would actually ask about this program.`;
}

module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  buildCourseExtractionPrompt,
};
