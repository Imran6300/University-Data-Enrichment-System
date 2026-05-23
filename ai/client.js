/**
 * UPGRADED: AI Client with model health tracking, circuit breaker,
 * and automatic failover — never gets stuck on a dead model
 */
const OpenAI = require("openai");

const aiClient = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
  timeout: 50000,
  maxRetries: 0, // We manage retries ourselves
});

// ──────────────────────────────────────────────
// Model Health Registry — tracks failures per model
// Prevents hammering dead models
// ──────────────────────────────────────────────
const modelHealth = new Map();

const CIRCUIT_BREAKER = {
  failureThreshold: 3, // failures before circuit opens
  resetAfterMs: 5 * 60 * 1000, // 5 min cooldown
};

function getModelHealth(model) {
  if (!modelHealth.has(model)) {
    modelHealth.set(model, { failures: 0, openUntil: 0, successes: 0 });
  }
  return modelHealth.get(model);
}

function isModelHealthy(model) {
  const h = getModelHealth(model);
  if (h.openUntil > Date.now()) return false; // circuit open
  return true;
}

function recordSuccess(model) {
  const h = getModelHealth(model);
  h.failures = 0;
  h.successes++;
  h.openUntil = 0;
}

function recordFailure(model) {
  const h = getModelHealth(model);
  h.failures++;
  if (h.failures >= CIRCUIT_BREAKER.failureThreshold) {
    h.openUntil = Date.now() + CIRCUIT_BREAKER.resetAfterMs;
    console.warn(`⚡ Circuit open for ${model} — cooling down 5min`);
  }
}

function getHealthyModels(models) {
  const healthy = models.filter(isModelHealthy);
  const degraded = models.filter((m) => !isModelHealthy(m));
  if (degraded.length > 0) {
    console.log(`⚠️ Skipping degraded models: ${degraded.join(", ")}`);
  }
  return healthy.length > 0 ? healthy : models; // fallback: try all if all degraded
}

module.exports = {
  aiClient,
  getHealthyModels,
  recordSuccess,
  recordFailure,
  isModelHealthy,
};
