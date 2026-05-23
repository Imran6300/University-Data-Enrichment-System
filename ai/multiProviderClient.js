/**
 * multiProviderClient.js
 *
 * Unified AI client supporting 4 free LLM providers:
 * 1. NVIDIA Build   — https://integrate.api.nvidia.com/v1  (free tier, 5 models)
 * 2. OpenRouter     — https://openrouter.ai/api/v1         (free models, no key needed for many)
 * 3. Groq           — https://api.groq.com/openai/v1       (free tier, very fast)
 * 4. HuggingFace    — https://api-inference.huggingface.co (free inference API)
 *
 * ARCHITECTURE:
 * ─────────────
 * Each provider has its own axios client (not OpenAI SDK) so HuggingFace's
 * different request format is handled cleanly.
 *
 * MODEL TIERS (for extraction):
 * - Tier 1 (best):  Large 70B models — highest quality, slower, rate limited
 * - Tier 2 (good):  Mid-size 8B-45B  — good quality, fast, more generous limits
 * - Tier 3 (fast):  Small 7B-8B      — for thin content / validation fallback
 *
 * CIRCUIT BREAKER:
 * - 3 consecutive failures → circuit OPEN for 5 min
 * - 429 rate limit → exponential backoff (not circuit open — it will recover)
 * - 400 bad request → mark model degraded (might be model-specific issue)
 *
 * ROTATION:
 * - Models rotate every 30s to spread load
 * - Within same tier, try cheapest/fastest first
 */

const axios = require("axios");

// ─────────────────────────────────────────────
// Provider configurations
// ─────────────────────────────────────────────
const PROVIDERS = {
  nvidia: {
    name: "NVIDIA",
    baseURL:
      process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY || "",
    enabled: !!process.env.NVIDIA_API_KEY,
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    enabled: !!process.env.OPENROUTER_API_KEY,
    extraHeaders: {
      "HTTP-Referer": process.env.APP_URL || "https://yourapp.com",
      "X-Title": "University Enrichment System",
    },
  },
  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY || "",
    enabled: !!process.env.GROQ_API_KEY,
  },
  huggingface: {
    name: "HuggingFace",
    baseURL: "https://api-inference.huggingface.co",
    apiKey: process.env.HUGGINGFACE_API_KEY || "",
    enabled: !!process.env.HUGGINGFACE_API_KEY,
  },
};

// ─────────────────────────────────────────────
// Model registry — all free models across providers
// tier: 1=best quality, 2=good, 3=fast/fallback
// ─────────────────────────────────────────────
const MODEL_REGISTRY = [
  // ── NVIDIA (your existing provider) ──
  {
    id: "nvidia::meta/llama-3.3-70b-instruct",
    provider: "nvidia",
    model: "meta/llama-3.3-70b-instruct",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "nvidia::meta/llama-3.1-70b-instruct",
    provider: "nvidia",
    model: "meta/llama-3.1-70b-instruct",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "nvidia::mistralai/mixtral-8x7b-instruct-v0.1",
    provider: "nvidia",
    model: "mistralai/mixtral-8x7b-instruct-v0.1",
    tier: 2,
    maxTokens: 2000,
    contextK: 32,
  },
  {
    id: "nvidia::meta/llama-3.1-8b-instruct",
    provider: "nvidia",
    model: "meta/llama-3.1-8b-instruct",
    tier: 2,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "nvidia::microsoft/phi-4-mini-instruct",
    provider: "nvidia",
    model: "microsoft/phi-4-mini-instruct",
    tier: 3,
    maxTokens: 1500,
    contextK: 16,
  },

  // ── Groq (fastest inference, generous free tier) ──
  {
    id: "groq::llama-3.3-70b-versatile",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "groq::llama-3.1-70b-versatile",
    provider: "groq",
    model: "llama-3.1-70b-versatile",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "groq::mixtral-8x7b-32768",
    provider: "groq",
    model: "mixtral-8x7b-32768",
    tier: 2,
    maxTokens: 2000,
    contextK: 32,
  },
  {
    id: "groq::llama3-70b-8192",
    provider: "groq",
    model: "llama3-70b-8192",
    tier: 1,
    maxTokens: 2000,
    contextK: 8,
  },
  {
    id: "groq::llama3-8b-8192",
    provider: "groq",
    model: "llama3-8b-8192",
    tier: 2,
    maxTokens: 2000,
    contextK: 8,
  },
  {
    id: "groq::gemma2-9b-it",
    provider: "groq",
    model: "gemma2-9b-it",
    tier: 2,
    maxTokens: 2000,
    contextK: 8,
  },
  {
    id: "groq::llama-3.1-8b-instant",
    provider: "groq",
    model: "llama-3.1-8b-instant",
    tier: 3,
    maxTokens: 1500,
    contextK: 128,
  },

  // ── OpenRouter (free models — :free suffix) ──
  {
    id: "openrouter::meta-llama/llama-3.3-70b-instruct:free",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "openrouter::meta-llama/llama-3.1-70b-instruct:free",
    provider: "openrouter",
    model: "meta-llama/llama-3.1-70b-instruct:free",
    tier: 1,
    maxTokens: 2000,
    contextK: 128,
  },
  {
    id: "openrouter::mistralai/mistral-7b-instruct:free",
    provider: "openrouter",
    model: "mistralai/mistral-7b-instruct:free",
    tier: 2,
    maxTokens: 2000,
    contextK: 32,
  },
  {
    id: "openrouter::google/gemma-2-9b-it:free",
    provider: "openrouter",
    model: "google/gemma-2-9b-it:free",
    tier: 2,
    maxTokens: 2000,
    contextK: 8,
  },
  {
    id: "openrouter::microsoft/phi-3-mini-128k-instruct:free",
    provider: "openrouter",
    model: "microsoft/phi-3-mini-128k-instruct:free",
    tier: 3,
    maxTokens: 1500,
    contextK: 128,
  },
  {
    id: "openrouter::qwen/qwen-2-7b-instruct:free",
    provider: "openrouter",
    model: "qwen/qwen-2-7b-instruct:free",
    tier: 3,
    maxTokens: 1500,
    contextK: 32,
  },
  {
    id: "openrouter::nousresearch/nous-capybara-7b:free",
    provider: "openrouter",
    model: "nousresearch/nous-capybara-7b:free",
    tier: 3,
    maxTokens: 1500,
    contextK: 4,
  },

  // ── HuggingFace Inference API (free, slower) ──
  {
    id: "huggingface::meta-llama/Llama-3.2-3B-Instruct",
    provider: "huggingface",
    model: "meta-llama/Llama-3.2-3B-Instruct",
    tier: 3,
    maxTokens: 1000,
    contextK: 8,
  },
  {
    id: "huggingface::mistralai/Mistral-7B-Instruct-v0.3",
    provider: "huggingface",
    model: "mistralai/Mistral-7B-Instruct-v0.3",
    tier: 3,
    maxTokens: 1000,
    contextK: 8,
  },
];

// ─────────────────────────────────────────────
// Health registry — per model ID
// ─────────────────────────────────────────────
const health = new Map(); // modelId → { failures, openUntil, rateLimitUntil, successes }

function getHealth(modelId) {
  if (!health.has(modelId)) {
    health.set(modelId, {
      failures: 0,
      openUntil: 0,
      rateLimitUntil: 0,
      successes: 0,
    });
  }
  return health.get(modelId);
}

function isAvailable(modelId) {
  const h = getHealth(modelId);
  if (h.openUntil > Date.now()) return false; // circuit open
  if (h.rateLimitUntil > Date.now()) return false; // rate limited
  return true;
}

function recordModelSuccess(modelId) {
  const h = getHealth(modelId);
  h.failures = 0;
  h.successes++;
  h.openUntil = 0;
}

function recordModelFailure(modelId, isRateLimit = false, retryAfterMs = 0) {
  const h = getHealth(modelId);

  if (isRateLimit) {
    // Rate limit: don't open circuit, just back off
    const backoff =
      retryAfterMs > 0
        ? retryAfterMs
        : Math.min(60000 * (h.failures + 1), 300000);
    h.rateLimitUntil = Date.now() + backoff;
    h.failures++; // still count but don't open circuit immediately
    console.warn(
      `⏳ Rate limit [${modelId}] — cooling ${Math.round(backoff / 1000)}s`,
    );
    return;
  }

  h.failures++;
  if (h.failures >= 3) {
    const cooldown = 5 * 60 * 1000;
    h.openUntil = Date.now() + cooldown;
    console.warn(`⚡ Circuit OPEN [${modelId}] — cooling 5min`);
  }
}

// ─────────────────────────────────────────────
// Get models by tier, excluding unavailable
// ─────────────────────────────────────────────
function getModelsForExtraction(preferredTiers = [1, 2, 3]) {
  const available = MODEL_REGISTRY.filter((m) => {
    if (!PROVIDERS[m.provider]?.enabled) return false;
    if (!isAvailable(m.id)) return false;
    if (!preferredTiers.includes(m.tier)) return false;
    return true;
  });

  // Rotate to spread load: change starting index every 30s
  const rotOffset =
    Math.floor(Date.now() / 30000) % Math.max(available.length, 1);
  const rotated = [
    ...available.slice(rotOffset),
    ...available.slice(0, rotOffset),
  ];

  // Sort: tier 1 first, then by rotation
  rotated.sort((a, b) => a.tier - b.tier);

  if (rotated.length === 0) {
    // All degraded — try NVIDIA as final fallback
    console.warn("⚠️ All models unavailable — forcing NVIDIA fallback");
    return MODEL_REGISTRY.filter((m) => m.provider === "nvidia").slice(0, 2);
  }

  return rotated;
}

function getModelsForValidation() {
  // Validation needs less power — prefer fast tier 2/3
  return getModelsForExtraction([2, 3, 1]);
}

// ─────────────────────────────────────────────
// HTTP call — unified across providers
// ─────────────────────────────────────────────
async function callModel(modelEntry, messages, maxTokens, timeoutMs = 45000) {
  const provider = PROVIDERS[modelEntry.provider];
  if (!provider?.enabled) {
    throw new Error(`Provider ${modelEntry.provider} not configured`);
  }

  // HuggingFace uses different request format
  if (modelEntry.provider === "huggingface") {
    return callHuggingFace(modelEntry, messages, maxTokens, timeoutMs);
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
    ...(provider.extraHeaders || {}),
  };

  const body = {
    model: modelEntry.model,
    messages,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: Math.min(maxTokens, modelEntry.maxTokens),
  };

  const response = await withTimeout(
    axios.post(`${provider.baseURL}/chat/completions`, body, {
      headers,
      timeout: timeoutMs,
      validateStatus: (s) => s < 600,
    }),
    timeoutMs,
    `${modelEntry.id}`,
  );

  if (response.status === 429) {
    const retryAfter =
      parseInt(response.headers?.["retry-after"] || "0") * 1000;
    const err = new Error(`429 Rate limit`);
    err.isRateLimit = true;
    err.retryAfterMs = retryAfter || 60000;
    throw err;
  }

  if (response.status === 400) {
    throw new Error(`400 Bad request — model may not support this format`);
  }

  if (response.status >= 500) {
    throw new Error(`${response.status} Server error`);
  }

  if (response.status >= 400) {
    throw new Error(
      `${response.status} Client error: ${JSON.stringify(response.data)?.slice(0, 100)}`,
    );
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");

  return content;
}

// ─────────────────────────────────────────────
// HuggingFace — text-generation API
// ─────────────────────────────────────────────
async function callHuggingFace(modelEntry, messages, maxTokens, timeoutMs) {
  const provider = PROVIDERS.huggingface;

  // Build prompt from messages
  const systemMsg = messages.find((m) => m.role === "system")?.content || "";
  const userMsg = messages.find((m) => m.role === "user")?.content || "";
  const prompt = `${systemMsg}\n\n${userMsg}`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };

  const body = {
    inputs: prompt,
    parameters: {
      max_new_tokens: Math.min(maxTokens, modelEntry.maxTokens),
      temperature: 0.1,
      return_full_text: false,
    },
    options: { wait_for_model: true },
  };

  const response = await withTimeout(
    axios.post(`${provider.baseURL}/models/${modelEntry.model}`, body, {
      headers,
      timeout: timeoutMs,
      validateStatus: (s) => s < 600,
    }),
    timeoutMs,
    modelEntry.id,
  );

  if (response.status === 503) {
    throw new Error("HuggingFace model loading — retry later");
  }

  if (response.status === 429) {
    const err = new Error("429 Rate limit");
    err.isRateLimit = true;
    err.retryAfterMs = 30000;
    throw err;
  }

  if (response.status >= 400) {
    throw new Error(`HuggingFace ${response.status}`);
  }

  // HF returns [{generated_text: "..."}]
  const text = Array.isArray(response.data)
    ? response.data[0]?.generated_text
    : response.data?.generated_text;

  if (!text) throw new Error("Empty HuggingFace response");
  return text;
}

// ─────────────────────────────────────────────
// withTimeout helper
// ─────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`⏱️ Timeout [${label}] after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────
// Provider status (for logging)
// ─────────────────────────────────────────────
function getProviderStatus() {
  const status = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const models = MODEL_REGISTRY.filter((m) => m.provider === key);
    const available = models.filter((m) => isAvailable(m.id)).length;
    status[key] = { enabled: p.enabled, total: models.length, available };
  }
  return status;
}

module.exports = {
  callModel,
  getModelsForExtraction,
  getModelsForValidation,
  recordModelSuccess,
  recordModelFailure,
  isAvailable,
  getProviderStatus,
  MODEL_REGISTRY,
  PROVIDERS,
};
