/**
 * crawlCache.js — FIXED
 *
 * Uses getCacheConnection() explicitly to avoid ambiguity.
 * getCacheConnection() has commandTimeout: 8000ms which is appropriate
 * for short cache GET/SET operations.
 *
 * Do NOT use getBullMQConnection() here — that's reserved for BullMQ only.
 */

const crypto = require("crypto");
const { getCacheConnection } = require("./redis");

const TTL = {
  PAGE_CONTENT: 24 * 3600, // 24h for crawled page content
  AI_EXTRACTION: 48 * 3600, // 48h for AI extraction results
  FAILED_URL: 7 * 24 * 3600, // 7 days for known-404 URLs
  DEDUP_CONTENT: 6 * 3600, // 6h for content hash dedup
};

const PREFIX = {
  PAGE: "cache:page:",
  EXTRACT: "cache:extract:",
  FAILED: "cache:fail:",
  CONTENT_HASH: "cache:contenthash:",
};

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function hashContent(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

// ─────────────────────────────────────────────
// Failed URL cache
// ─────────────────────────────────────────────
async function markUrlFailed(url, reason, statusCode) {
  const permanentFailure =
    statusCode === 404 ||
    (reason && (reason.includes("ENOTFOUND") || reason.includes("Not Found")));

  if (!permanentFailure) return;

  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.FAILED}${hashUrl(url)}`;
    await redis.setex(
      key,
      TTL.FAILED_URL,
      JSON.stringify({ url, reason, statusCode, ts: Date.now() }),
    );
  } catch {
    // Non-fatal
  }
}

async function isUrlPermanentlyFailed(url) {
  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.FAILED}${hashUrl(url)}`;
    const val = await redis.get(key);
    return val !== null;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Page content cache
// ─────────────────────────────────────────────
async function getCachedPage(url) {
  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.PAGE}${hashUrl(url)}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cachePageContent(url, data) {
  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.PAGE}${hashUrl(url)}`;
    await redis.setex(
      key,
      TTL.PAGE_CONTENT,
      JSON.stringify({
        url,
        cleanedText: data.cleanedText,
        images: (data.images || []).slice(0, 50),
        statusCode: data.statusCode,
        cachedAt: Date.now(),
      }),
    );
  } catch {
    // Non-fatal
  }
}

// ─────────────────────────────────────────────
// Content deduplication
// ─────────────────────────────────────────────
async function isContentDuplicate(text) {
  if (!text || text.length < 200) return false;
  try {
    const redis = getCacheConnection();
    const hash = hashContent(text);
    const key = `${PREFIX.CONTENT_HASH}${hash}`;
    const exists = await redis.exists(key);
    if (exists) return true;
    await redis.setex(key, TTL.DEDUP_CONTENT, "1");
    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// AI extraction cache
// ─────────────────────────────────────────────
async function getCachedExtraction(universityId, contentHash) {
  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.EXTRACT}${universityId}:${contentHash}`;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cacheExtraction(universityId, contentHash, result) {
  try {
    const redis = getCacheConnection();
    const key = `${PREFIX.EXTRACT}${universityId}:${contentHash}`;
    await redis.setex(key, TTL.AI_EXTRACTION, JSON.stringify(result));
  } catch {
    // Non-fatal
  }
}

function computeContentHash(content) {
  return hashContent(content.slice(0, 10000));
}

module.exports = {
  markUrlFailed,
  isUrlPermanentlyFailed,
  getCachedPage,
  cachePageContent,
  isContentDuplicate,
  getCachedExtraction,
  cacheExtraction,
  computeContentHash,
};
