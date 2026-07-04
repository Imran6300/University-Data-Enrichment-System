/**
 * seoMetaPrompt.js
 *
 * PHASE 7b: prompt for generating click-through-optimized <title> and
 * meta description text.
 *
 * WHY THIS EXISTS NOW (Phase 7, Section 0):
 * Google fully deprecated FAQ rich results on 2026-05-07 — no site gets
 * that SERP treatment anymore, for any reason. That removes FAQ
 * snippets as a CTR lever entirely, which makes title/meta description
 * text the dominant remaining lever this platform controls for
 * click-through rate. This prompt is the centerpiece of Phase 7b.
 *
 * Length limits are enforced in generateSeoMeta.js AFTER the model
 * responds, not just requested here — AI models don't reliably respect
 * length instructions, so the prompt asks for a safe target and the
 * caller truncates/rejects+retries against the hard limit.
 */

const EXTRACTION_SYSTEM_PROMPT = `You are an SEO copywriter for a study-abroad platform. Write compelling, honest, click-worthy page titles and meta descriptions. Return ONLY raw valid JSON — no markdown, no \`\`\`json fences, no prose, no explanations.`;

// Hard limits enforced in code (generateSeoMeta.js). These are the
// *target* lengths given to the model — deliberately a bit under the
// hard ceiling so a slightly-long model response still survives
// truncation without losing its ending mid-word as often.
const TITLE_TARGET_CHARS = 55;
const DESCRIPTION_TARGET_CHARS = 145;

const CURRENT_YEAR = new Date().getFullYear();

function buildEntityContext(entityType, entity) {
  switch (entityType) {
    case "country":
      return `Entity type: Country
Country name: ${entity.name}
Visa success rate: ${entity.visaSuccessRate ?? "N/A"}%
Notable: ${(entity.whyStudyCards || [])
        .slice(0, 2)
        .map((c) => c.title)
        .join(", ") || "N/A"}`;

    case "course":
      return `Entity type: Course
Course title: ${entity.title}
Level: ${entity.level || "N/A"}
Field: ${entity.field || "N/A"}`;

    case "university":
      return `Entity type: University
University name: ${entity.name}
City: ${entity.city || "N/A"}
Country: ${entity.country?.name || "N/A"}
QS ranking: ${entity.qsRanking ? `#${entity.qsRanking}` : "N/A"}`;

    default:
      throw new Error(`Unknown entity type for SEO meta prompt: ${entityType}`);
  }
}

function buildSeoMetaPrompt(entityType, entity) {
  const context = buildEntityContext(entityType, entity);

  return `Write an SEO title and meta description for this page on Khizar Overseas, a study-abroad platform.

${context}

Return ONLY valid JSON in this exact shape:
{
  "title": "...",
  "description": "..."
}

Rules:
- title: at most ${TITLE_TARGET_CHARS} characters. Must include the entity name verbatim (see above) and, where it fits naturally, a number (a ranking, a count, a fee figure) or the current year (${CURRENT_YEAR}). End with "| Khizar Overseas" only if it fits within the limit — omit it rather than truncate the meaningful part of the title.
- description: at most ${DESCRIPTION_TARGET_CHARS} characters. Written as a reason to click: what the searcher will find on this exact page. Include the entity name verbatim. Avoid generic filler like "explore" and "discover" used more than once between title and description combined.
- No markdown, no explanations, no extra keys, no trailing period requirement.
- Do not fabricate specific numbers (fees, rankings, success rates) that weren't given to you above — if you don't have a real number, use a qualitative hook instead (e.g. "Top-ranked", "Scholarship options") rather than inventing a figure.
- Never use quotation marks inside the title or description text itself.`;
}

module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  buildSeoMetaPrompt,
  TITLE_TARGET_CHARS,
  DESCRIPTION_TARGET_CHARS,
};
