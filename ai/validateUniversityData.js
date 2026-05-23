/**
 * validateUniversityData.js — Multi-Provider Upgrade
 *
 * Uses multiProviderClient for validation fallback.
 * Validation prefers fast Tier 2/3 models since it needs less intelligence than extraction.
 * Most validations skip AI entirely (structural score >= 0.82).
 */

const {
  callModel,
  getModelsForValidation,
  recordModelSuccess,
  recordModelFailure,
} = require("./multiProviderClient");

const {
  VALIDATION_SYSTEM_PROMPT,
  buildValidationPrompt,
} = require("./prompts/validationPrompt");

const { parseJsonResponse } = require("./extractUniversityData");

const CONFIDENCE_THRESHOLD =
  parseFloat(process.env.CONFIDENCE_THRESHOLD) || 0.62;
const CONFIDENCE_TRUSTED = parseFloat(process.env.CONFIDENCE_TRUSTED) || 0.8;
const VALIDATION_TIMEOUT_MS = 20000;
const SKIP_AI_VALIDATION_THRESHOLD = 0.82;

// ─────────────────────────────────────────────
// Structural score — field presence + quality
// ─────────────────────────────────────────────
function computeStructuralScore(data) {
  let score = 0.55;

  // Description quality
  if (data.description) {
    const len = data.description.length;
    if (len >= 150) score += 0.1;
    else if (len >= 80) score += 0.07;
    else if (len >= 40) score += 0.03;
  }

  // Location
  if (data.city) score += 0.04;
  if (data.country) score += 0.05;

  // Programs
  const progCount = data.programs?.length || 0;
  if (progCount >= 5) score += 0.08;
  else if (progCount >= 3) score += 0.06;
  else if (progCount >= 1) score += 0.03;

  // Admission requirements
  const reqCount = data.admissionRequirements?.length || 0;
  if (reqCount >= 4) score += 0.05;
  else if (reqCount >= 2) score += 0.03;
  else if (reqCount >= 1) score += 0.01;

  // Intakes
  const intakeCount = data.intakes?.length || 0;
  if (intakeCount >= 2) score += 0.04;
  else if (intakeCount >= 1) score += 0.02;

  // Optional bonus fields
  if (data.tuitionFee) score += 0.04;
  if (data.totalStudents) score += 0.02;
  if (data.qsRanking) score += 0.02;
  if (data.acceptanceRate) score += 0.02;
  if (data.similarUniversities?.length >= 1) score += 0.01;

  return Math.min(0.97, score);
}

// ─────────────────────────────────────────────
// Structural checks — detect obvious problems
// ─────────────────────────────────────────────
function runStructuralChecks(data) {
  const issues = [];

  if (data.qsRanking != null) {
    if (
      !Number.isInteger(data.qsRanking) ||
      data.qsRanking < 1 ||
      data.qsRanking > 1500
    ) {
      issues.push(`CRITICAL: Invalid QS ranking: ${data.qsRanking}`);
    }
  }

  if (data.acceptanceRate != null) {
    if (data.acceptanceRate < 0.1 || data.acceptanceRate > 100) {
      issues.push(`CRITICAL: Invalid acceptance rate: ${data.acceptanceRate}`);
    }
  }

  if (data.programs && !Array.isArray(data.programs)) {
    issues.push("CRITICAL: programs must be array");
  }

  const VALID_LEVELS = [
    "Undergraduate",
    "Postgraduate",
    "PhD",
    "Diploma",
    "Certificate",
  ];
  if (Array.isArray(data.programs)) {
    data.programs.forEach((p, i) => {
      if (!VALID_LEVELS.includes(p.level)) {
        issues.push(`Program[${i}] invalid level: "${p.level}"`);
      }
    });
  }

  if (data.description) {
    if (data.description.length < 20) {
      issues.push("Description too short");
    }
    if (
      /^(learn more|click here|home|menu|contact us|toggle|cookie|accept)/i.test(
        data.description.trim(),
      )
    ) {
      issues.push(
        "CRITICAL: Description looks like navigation/boilerplate text",
      );
    }
  }

  return issues;
}

// ─────────────────────────────────────────────
// AI validation — uses fast validation models
// ─────────────────────────────────────────────
async function runAIValidation(extractedData, universityName) {
  const prompt = buildValidationPrompt(extractedData, universityName);
  const models = getModelsForValidation();

  let lastError = null;

  for (const modelEntry of models) {
    try {
      console.log(`🛡️ Validation model: ${modelEntry.id}`);

      const raw = await callModel(
        modelEntry,
        [
          { role: "system", content: VALIDATION_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        600,
        VALIDATION_TIMEOUT_MS,
      );

      if (!raw) throw new Error("Empty validation response");

      const parsed = parseJsonResponse(raw);
      if (!parsed) throw new Error("No JSON in validation response");

      // Some small models return 0.5 as default — override with structural score
      const structuralScore = computeStructuralScore(extractedData);
      if (
        typeof parsed.confidenceScore !== "number" ||
        parsed.confidenceScore === 0.5
      ) {
        parsed.confidenceScore = Math.max(structuralScore, 0.55);
        parsed._scoreOverridden = true;
      }

      recordModelSuccess(modelEntry.id);
      console.log(
        `✅ Validation OK [${modelEntry.id}] score=${parsed.confidenceScore}`,
      );
      return parsed;
    } catch (err) {
      const msg = err.message || "";
      const isRateLimit = err.isRateLimit || msg.includes("429");

      if (isRateLimit) {
        recordModelFailure(modelEntry.id, true, err.retryAfterMs || 60000);
      } else {
        console.warn(
          `❌ Validation model failed [${modelEntry.id}]: ${msg.slice(0, 80)}`,
        );
        recordModelFailure(modelEntry.id, false);
      }
      lastError = err;
    }
  }

  throw lastError || new Error("All validation models failed");
}

// ─────────────────────────────────────────────
// Fallback validation when AI unavailable
// ─────────────────────────────────────────────
function buildFallbackValidation(data, structuralIssues, structuralScore) {
  const hasCritical = structuralIssues.some((i) => i.startsWith("CRITICAL:"));
  const score = hasCritical ? 0.2 : structuralScore;

  return {
    valid: !hasCritical && score >= CONFIDENCE_THRESHOLD,
    confidenceScore: score,
    issues: structuralIssues,
    hallucinations: [],
    recommendation: hasCritical
      ? "reject"
      : score >= CONFIDENCE_TRUSTED
        ? "accept"
        : "partial",
    fieldScores: {},
  };
}

// ─────────────────────────────────────────────
// Final score blend
// ─────────────────────────────────────────────
function calculateFinalScore(data, aiValidation, structuralScore) {
  const aiScore = aiValidation.confidenceScore || structuralScore;
  const isAiReal =
    !aiValidation.validationSkipped &&
    !aiValidation._scoreOverridden &&
    aiScore !== 0.5;

  let score = isAiReal
    ? aiScore * 0.55 + structuralScore * 0.45
    : structuralScore * 0.85 + aiScore * 0.15;

  // Critical penalties
  if (!data.description) score -= 0.12;
  if (!data.programs?.length) score -= 0.06;
  if (!data.country) score -= 0.05;

  const hallucinations = (aiValidation.hallucinations || []).length;
  if (hallucinations > 0) score -= hallucinations * 0.08;

  return Math.max(0, Math.min(0.98, parseFloat(score.toFixed(3))));
}

// ─────────────────────────────────────────────
// Main validation function
// ─────────────────────────────────────────────
async function validateUniversityData(extractedData, universityName) {
  const structuralIssues = runStructuralChecks(extractedData);
  const criticalFail = structuralIssues.some((i) => i.startsWith("CRITICAL:"));

  if (criticalFail) {
    return {
      valid: false,
      confidenceScore: 0.15,
      issues: structuralIssues,
      hallucinations: [],
      status: "reject",
      aiRecommendation: "reject",
      fieldScores: {},
    };
  }

  const structuralScore = computeStructuralScore(extractedData);

  // Skip AI validation for high-quality data — saves API quota
  if (structuralScore >= SKIP_AI_VALIDATION_THRESHOLD) {
    console.log(
      `⚡ Skipping AI validation (structural score ${structuralScore.toFixed(2)})`,
    );
    return {
      valid: true,
      confidenceScore: structuralScore,
      issues: structuralIssues,
      hallucinations: [],
      status: structuralScore >= CONFIDENCE_TRUSTED ? "accept" : "partial",
      aiRecommendation: "accept",
      fieldScores: {},
      validationSkipped: true,
    };
  }

  let aiValidation;
  try {
    aiValidation = await runAIValidation(extractedData, universityName);
  } catch (err) {
    console.warn(
      `⚠️ AI validation failed for ${universityName}: ${err.message}`,
    );
    aiValidation = buildFallbackValidation(
      extractedData,
      structuralIssues,
      structuralScore,
    );
  }

  const allIssues = [...structuralIssues, ...(aiValidation.issues || [])];
  const finalScore = calculateFinalScore(
    extractedData,
    aiValidation,
    structuralScore,
  );

  let status = "reject";
  if (finalScore >= CONFIDENCE_TRUSTED) status = "accept";
  else if (finalScore >= CONFIDENCE_THRESHOLD) status = "partial";

  return {
    valid: finalScore >= CONFIDENCE_THRESHOLD,
    confidenceScore: finalScore,
    issues: [...new Set(allIssues)],
    hallucinations: aiValidation.hallucinations || [],
    status,
    aiRecommendation: aiValidation.recommendation || "partial",
    fieldScores: aiValidation.fieldScores || {},
  };
}

module.exports = { validateUniversityData };
