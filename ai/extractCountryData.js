/**
 * extractCountryData.js
 *
 * PHASE 4 (2026-07): replaces services/scripts/enrichCountries.js's direct,
 * single-provider OpenRouter call with the same multi-provider fallback
 * chain (NVIDIA -> Groq -> OpenRouter -> HuggingFace) the university
 * pipeline already uses — same circuit breaker, same rate-limit handling,
 * same tier-based model rotation. One retry/fallback implementation for
 * the whole platform instead of two.
 */

const {
  callModel,
  getModelsForExtraction,
  recordModelSuccess,
  recordModelFailure,
} = require("./multiProviderClient");

const {
  EXTRACTION_SYSTEM_PROMPT,
  buildCountryExtractionPrompt,
} = require("./prompts/countryExtractionPrompt");

const MODEL_TIMEOUT_MS = 45000;

// ─────────────────────────────────────────────
// Validation — ported from the original script's isValidArray /
// isValidWhyStudyCards, unchanged in spirit.
// ─────────────────────────────────────────────
function isValidArray(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function isValidWhyStudyCards(cards) {
  return (
    Array.isArray(cards) &&
    cards.length > 0 &&
    cards.every(
      (card) =>
        card &&
        typeof card.title === "string" &&
        card.title.trim().length > 0 &&
        typeof card.description === "string" &&
        card.description.trim().length > 0,
    )
  );
}

function validateCountryContent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  return (
    isValidArray(parsed.careerOpportunities) &&
    isValidArray(parsed.scholarships) &&
    isValidArray(parsed.eligibilityRequirements) &&
    isValidWhyStudyCards(parsed.whyStudyCards)
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
async function runSingleCountryExtraction(countryName, modelEntry) {
  const prompt = buildCountryExtractionPrompt(countryName);
  const maxTokens = modelEntry.provider === "huggingface" ? 800 : 1500;

  console.log(`🤖 [${countryName}] Country content model: ${modelEntry.id}`);

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
  if (!validateCountryContent(parsed)) {
    throw new Error("Invalid or incomplete country content structure");
  }

  parsed._model = modelEntry.id;
  parsed._provider = modelEntry.provider;
  return parsed;
}

// ─────────────────────────────────────────────
// Main entry — tries all providers/models in priority order, same
// fallback behavior as runExtraction() in extractUniversityData.js
// ─────────────────────────────────────────────
async function extractCountryData(countryName) {
  const models = getModelsForExtraction([1, 2, 3]);

  if (models.length === 0) {
    throw new Error("No AI models available across any provider");
  }

  let lastError = null;

  for (const modelEntry of models) {
    try {
      const result = await runSingleCountryExtraction(countryName, modelEntry);
      recordModelSuccess(modelEntry.id);
      console.log(`✅ [${countryName}] Extracted via ${modelEntry.id}`);
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
          console.warn(`⏱️ [${countryName}] Timeout [${modelEntry.id}]`);
        } else {
          console.warn(
            `❌ [${countryName}] Extraction failed [${modelEntry.id}]: ${msg.slice(0, 100)}`,
          );
        }
        recordModelFailure(modelEntry.id, false);
      }

      lastError = err;
      // Continue to next model — this is the whole point of the
      // multi-provider migration: one bad/rate-limited model no longer
      // stalls the whole country for 60s like the old MAX_RETRIES loop did.
    }
  }

  throw lastError || new Error("All models failed country extraction");
}

module.exports = {
  extractCountryData,
  validateCountryContent,
};
