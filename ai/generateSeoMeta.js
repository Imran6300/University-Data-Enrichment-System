/**
 * generateSeoMeta.js
 *
 * PHASE 7b: AI-generated <title>/meta description for Country, Course,
 * and University pages, reusing the same multi-provider fallback chain
 * (NVIDIA -> Groq -> OpenRouter -> HuggingFace) as
 * extractCountryData.js / extractCourseData.js. One retry/fallback
 * implementation for the whole platform instead of a new one per phase.
 *
 * HARD LENGTH LIMITS — enforced here in code, not just in the prompt:
 * AI models do not reliably respect length instructions. A model that
 * overshoots is truncated at a word boundary; if truncation would cut
 * off too much of the content (more than TRUNCATE_TOLERANCE_RATIO of
 * the string), that's treated as a failed attempt and retried with the
 * next model instead of silently publishing a mangled string.
 *
 * SCORING CHECK — a lightweight pre-publish gate, not a full ML model:
 * does the title/description include the entity name verbatim, and
 * does the title include a number or the current year? Below threshold
 * -> regenerate with the next model rather than publish as-is.
 */

const {
  callModel,
  getModelsForExtraction,
  recordModelSuccess,
  recordModelFailure,
} = require("./multiProviderClient");

const {
  EXTRACTION_SYSTEM_PROMPT,
  buildSeoMetaPrompt,
} = require("./prompts/seoMetaPrompt");

const MODEL_TIMEOUT_MS = 30000;

// Hard ceilings — see Phase 7b brief: title <=60, description <=155.
const TITLE_MAX_CHARS = 60;
const DESCRIPTION_MAX_CHARS = 155;

// If truncating to the hard limit would remove more than this fraction
// of the model's original string, don't publish a mangled fragment —
// treat it as a failed attempt and let the caller try the next model.
const TRUNCATE_TOLERANCE_RATIO = 0.25;

const CURRENT_YEAR = new Date().getFullYear();

// ─────────────────────────────────────────────
// JSON parsing (same pattern as extractCountryData.js)
// ─────────────────────────────────────────────
function parseJsonResponse(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// Repair a dangling trailing separator or an incomplete brand tag that
// the MODEL itself produced — independent of length truncation below.
//
// BUGFIX: titles like "Study in Afghanistan - 31% Visa Success Rate |
// Khizar" (53 chars) and "...Rate |" (54 chars) were observed in
// production — both well under TITLE_MAX_CHARS (60), so enforceLength's
// truncation never fired on them. The model itself generated an
// incomplete "| Khizar" fragment or a bare trailing "|" with nothing
// after it. This repairs both patterns before length enforcement runs.
// ─────────────────────────────────────────────
const BRAND_SUFFIX = "Khizar Overseas";

function repairDanglingSuffix(text) {
  let t = (text || "").trim();

  // Case 1: ends with a bare separator and nothing meaningful after it
  // (e.g. "...Success Rate |", "...Success Rate -", "...Rate:").
  if (/[|\-\u2013\u2014:,]\s*$/.test(t)) {
    return t.replace(/[\s|\-\u2013\u2014:,]+$/, "").trim();
  }

  // Case 2: ends with an incomplete prefix of the brand tag, e.g.
  // "| Khizar" or "| Khizar Over" instead of the full "| Khizar Overseas".
  const lastPipe = t.lastIndexOf("|");
  if (lastPipe !== -1) {
    const after = t.slice(lastPipe + 1).trim();
    const isCompleteBrand = after === BRAND_SUFFIX;
    const isPartialBrandPrefix =
      after.length > 0 &&
      BRAND_SUFFIX.toLowerCase().startsWith(after.toLowerCase());
    if (!isCompleteBrand && isPartialBrandPrefix) {
      return t.slice(0, lastPipe).trim();
    }
  }

  return t;
}

// ─────────────────────────────────────────────
// Hard length enforcement — truncate at a word boundary or reject
// ─────────────────────────────────────────────
function enforceLength(text, maxChars) {
  const trimmed = repairDanglingSuffix((text || "").trim());
  if (trimmed.length <= maxChars) return trimmed;

  // Prefer dropping a trailing "| Brand" suffix whole rather than
  // truncating mid-way through it — a clean title without the brand
  // tag beats a mangled half-brand tag.
  const lastPipeIdx = trimmed.lastIndexOf(" | ");
  if (lastPipeIdx !== -1) {
    const withoutSuffix = trimmed.slice(0, lastPipeIdx).trim();
    if (withoutSuffix.length > 0 && withoutSuffix.length <= maxChars) {
      return withoutSuffix;
    }
  }

  const truncatedTooMuch =
    (trimmed.length - maxChars) / trimmed.length > TRUNCATE_TOLERANCE_RATIO;
  if (truncatedTooMuch) return null; // caller treats this as a failed attempt

  const slice = trimmed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = (
    lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice
  ).trim();
  return repairDanglingSuffix(cut);
}

// ─────────────────────────────────────────────
// Lightweight pre-publish scoring — not a full ML model, just checks
// the things the Phase 7b brief calls out explicitly.
// ─────────────────────────────────────────────
function getEntityName(entityType, entity) {
  if (entityType === "course") return entity.title;
  return entity.name;
}

function scoreMeta(entityType, entity, title, description) {
  const entityName = (getEntityName(entityType, entity) || "").toLowerCase();
  const titleLower = title.toLowerCase();
  const descLower = description.toLowerCase();

  let score = 0;
  const checks = {
    titleHasEntityName: entityName && titleLower.includes(entityName),
    descHasEntityName: entityName && descLower.includes(entityName),
    titleHasNumberOrYear:
      /\d/.test(title) || title.includes(String(CURRENT_YEAR)),
    descriptionNotEmpty: description.length > 20,
  };

  for (const passed of Object.values(checks)) if (passed) score++;

  return { score, maxScore: Object.keys(checks).length, checks };
}

const SCORE_THRESHOLD = 3; // out of 4 — see checks above

// ─────────────────────────────────────────────
// Single generation attempt with one model
// ─────────────────────────────────────────────
async function runSingleMetaGeneration(entityType, entity, modelEntry) {
  const prompt = buildSeoMetaPrompt(entityType, entity);
  const maxTokens = modelEntry.provider === "huggingface" ? 300 : 400;

  const label = getEntityName(entityType, entity);
  console.log(`🤖 [${entityType}:${label}] SEO meta model: ${modelEntry.id}`);

  const raw = await callModel(
    modelEntry,
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    maxTokens,
    MODEL_TIMEOUT_MS,
  );

  const parsed = parseJsonResponse(raw);
  if (
    !parsed ||
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string"
  ) {
    throw new Error("Invalid or incomplete SEO meta structure");
  }

  const title = enforceLength(parsed.title, TITLE_MAX_CHARS);
  const description = enforceLength(parsed.description, DESCRIPTION_MAX_CHARS);

  if (!title || !description) {
    throw new Error(
      "Model response too long to safely truncate to hard length limits",
    );
  }

  const { score, maxScore, checks } = scoreMeta(
    entityType,
    entity,
    title,
    description,
  );

  if (score < SCORE_THRESHOLD) {
    throw new Error(
      `SEO meta scored ${score}/${maxScore} (below threshold ${SCORE_THRESHOLD}) — ${JSON.stringify(checks)}`,
    );
  }

  return {
    title,
    description,
    _score: score,
    _maxScore: maxScore,
    _model: modelEntry.id,
    _provider: modelEntry.provider,
  };
}

// ─────────────────────────────────────────────
// Main entry — tries all providers/models in priority order until one
// produces a result that passes both the length gate and the score gate.
// ─────────────────────────────────────────────
async function generateSeoMeta(entityType, entity) {
  const models = getModelsForExtraction([1, 2, 3]);

  if (models.length === 0) {
    throw new Error("No AI models available across any provider");
  }

  const label = getEntityName(entityType, entity);
  let lastError = null;

  for (const modelEntry of models) {
    try {
      const result = await runSingleMetaGeneration(
        entityType,
        entity,
        modelEntry,
      );
      recordModelSuccess(modelEntry.id);
      console.log(
        `✅ [${entityType}:${label}] SEO meta generated via ${modelEntry.id} (score ${result._score}/${result._maxScore})`,
      );
      return result;
    } catch (err) {
      const msg = err.message || "";
      const isRateLimit =
        err.isRateLimit || msg.includes("429") || msg.includes("rate limit");
      const isTimeout = msg.includes("Timeout") || msg.includes("timeout");

      if (isRateLimit) {
        recordModelFailure(modelEntry.id, true, err.retryAfterMs || 60000);
      } else {
        if (isTimeout) {
          console.warn(
            `⏱️ [${entityType}:${label}] Timeout [${modelEntry.id}]`,
          );
        } else {
          console.warn(
            `❌ [${entityType}:${label}] SEO meta failed [${modelEntry.id}]: ${msg.slice(0, 140)}`,
          );
        }
        recordModelFailure(modelEntry.id, false);
      }

      lastError = err;
      // Continue to next model — same fallback discipline as
      // extractCountryData.js / extractCourseData.js.
    }
  }

  throw lastError || new Error("All models failed SEO meta generation");
}

module.exports = {
  generateSeoMeta,
  enforceLength,
  scoreMeta,
  TITLE_MAX_CHARS,
  DESCRIPTION_MAX_CHARS,
  SCORE_THRESHOLD,
};
