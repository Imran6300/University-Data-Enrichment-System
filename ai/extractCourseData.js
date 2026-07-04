/**
 * extractCourseData.js
 *
 * PHASE 5b (2026-07): course content extraction, using the exact same
 * multi-provider fallback chain (NVIDIA -> Groq -> OpenRouter ->
 * HuggingFace) as extractUniversityData.js and extractCountryData.js —
 * same circuit breaker, same rate-limit handling, same tier-based model
 * rotation. One retry/fallback implementation for the whole platform.
 */

const {
  callModel,
  getModelsForExtraction,
  recordModelSuccess,
  recordModelFailure,
} = require("./multiProviderClient");

const {
  EXTRACTION_SYSTEM_PROMPT,
  buildCourseExtractionPrompt,
} = require("./prompts/courseExtractionPrompt");

const MODEL_TIMEOUT_MS = 45000;

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────
function isValidArray(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function isValidEntryRequirements(items) {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      (item) =>
        item &&
        typeof item.title === "string" &&
        item.title.trim().length > 0 &&
        typeof item.description === "string" &&
        item.description.trim().length > 0,
    )
  );
}

function isValidFaqs(items) {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      (item) =>
        item &&
        typeof item.question === "string" &&
        item.question.trim().length > 0 &&
        typeof item.answer === "string" &&
        item.answer.trim().length > 0,
    )
  );
}

function isNonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0;
}

function validateCourseContent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  return (
    isNonEmptyString(parsed.subtitle) &&
    isNonEmptyString(parsed.overviewTitle) &&
    isNonEmptyString(parsed.overviewDescription) &&
    isValidArray(parsed.keyHighlights) &&
    isValidEntryRequirements(parsed.entryRequirements) &&
    isNonEmptyString(parsed.careerProspects) &&
    isValidArray(parsed.popularJobRoles) &&
    isNonEmptyString(parsed.salaryExpectations) &&
    isValidFaqs(parsed.faqs)
  );
}

function parseJsonResponse(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Some models wrap JSON in extra prose despite instructions — try to
    // salvage by grabbing the outermost {...} block.
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
// Single extraction attempt with one model
// ─────────────────────────────────────────────
async function runSingleCourseExtraction(course, modelEntry) {
  const prompt = buildCourseExtractionPrompt(course);
  const maxTokens = modelEntry.provider === "huggingface" ? 1000 : 1800;

  console.log(`🤖 [${course.title}] Course content model: ${modelEntry.id}`);

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
  if (!validateCourseContent(parsed)) {
    throw new Error("Invalid or incomplete course content structure");
  }

  parsed._model = modelEntry.id;
  parsed._provider = modelEntry.provider;
  return parsed;
}

// ─────────────────────────────────────────────
// Main entry — tries all providers/models in priority order, same
// fallback behavior as extractCountryData.js / extractUniversityData.js
//
// @param {object} course - { title, field, level } (only what the prompt
//   needs — pass the plain fields, not a full Mongoose doc).
// ─────────────────────────────────────────────
async function extractCourseData(course) {
  const models = getModelsForExtraction([1, 2, 3]);

  if (models.length === 0) {
    throw new Error("No AI models available across any provider");
  }

  let lastError = null;

  for (const modelEntry of models) {
    try {
      const result = await runSingleCourseExtraction(course, modelEntry);
      recordModelSuccess(modelEntry.id);
      console.log(`✅ [${course.title}] Extracted via ${modelEntry.id}`);
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
          console.warn(`⏱️ [${course.title}] Timeout [${modelEntry.id}]`);
        } else {
          console.warn(
            `❌ [${course.title}] Extraction failed [${modelEntry.id}]: ${msg.slice(0, 100)}`,
          );
        }
        recordModelFailure(modelEntry.id, false);
      }

      lastError = err;
      // Continue to next model — one bad/rate-limited model shouldn't
      // stall this course's enrichment.
    }
  }

  throw lastError || new Error("All models failed course extraction");
}

module.exports = {
  extractCourseData,
  validateCourseContent,
};
