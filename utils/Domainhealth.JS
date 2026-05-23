/**
 * domainHealth.js — FIXED
 *
 * Uses getCacheConnection() explicitly.
 * No changes to logic — only the Redis connection import is fixed.
 */

const { getCacheConnection } = require("./redis");

const DOMAIN_KEY_PREFIX = "domainhealth:";
const DOMAIN_TTL_SEC = 6 * 3600;

const localCache = new Map();

const STATUS = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  BLOCKED: "blocked",
  DEAD: "dead",
};

const THRESHOLDS = {
  BLOCK_403_COUNT: 3,
  DEAD_TIMEOUT_COUNT: 3,
  DEGRADED_FAIL_RATE: 0.6,
};

function getDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function loadDomainHealth(domain) {
  if (localCache.has(domain)) {
    const cached = localCache.get(domain);
    if (cached.until > Date.now()) return cached;
  }

  try {
    const redis = getCacheConnection();
    const raw = await redis.get(`${DOMAIN_KEY_PREFIX}${domain}`);
    if (!raw) return null;
    const data = JSON.parse(raw);
    localCache.set(domain, { ...data, until: Date.now() + 30000 });
    return data;
  } catch {
    return null;
  }
}

async function saveDomainHealth(domain, data) {
  try {
    const redis = getCacheConnection();
    await redis.setex(
      `${DOMAIN_KEY_PREFIX}${domain}`,
      DOMAIN_TTL_SEC,
      JSON.stringify(data),
    );
    localCache.set(domain, { ...data, until: Date.now() + 30000 });
  } catch {
    // Non-fatal
  }
}

async function canCrawlUrl(url) {
  const domain = getDomain(url);
  if (!domain)
    return { canCrawl: false, reason: "Invalid URL", status: STATUS.DEAD };

  const health = await loadDomainHealth(domain);
  if (!health)
    return { canCrawl: true, reason: "No data", status: STATUS.HEALTHY };

  if (health.status === STATUS.BLOCKED) {
    return {
      canCrawl: false,
      reason: `Domain blocked (${health.block403Count} 403s)`,
      status: STATUS.BLOCKED,
    };
  }

  if (health.status === STATUS.DEAD) {
    return {
      canCrawl: false,
      reason: `Domain dead (${health.deadCount} failures)`,
      status: STATUS.DEAD,
    };
  }

  return {
    canCrawl: true,
    reason: "OK",
    status: health.status || STATUS.HEALTHY,
  };
}

async function recordCrawlResult(url, { statusCode, error }) {
  const domain = getDomain(url);
  if (!domain) return;

  const health = (await loadDomainHealth(domain)) || {
    domain,
    status: STATUS.HEALTHY,
    totalAttempts: 0,
    totalSuccess: 0,
    block403Count: 0,
    deadCount: 0,
    lastSeen: null,
  };

  health.totalAttempts++;
  health.lastSeen = new Date().toISOString();

  const msg = error?.message || "";

  if (statusCode === 403 || msg.includes("403") || msg.includes("Forbidden")) {
    health.block403Count = (health.block403Count || 0) + 1;
    if (health.block403Count >= THRESHOLDS.BLOCK_403_COUNT) {
      health.status = STATUS.BLOCKED;
      console.warn(
        `🚫 Domain BLOCKED: ${domain} (${health.block403Count} 403s)`,
      );
    } else {
      health.status = STATUS.DEGRADED;
    }
  } else if (
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timeout")
  ) {
    health.deadCount = (health.deadCount || 0) + 1;
    if (health.deadCount >= THRESHOLDS.DEAD_TIMEOUT_COUNT) {
      health.status = STATUS.DEAD;
      console.warn(`💀 Domain DEAD: ${domain} (${health.deadCount} timeouts)`);
    } else {
      health.status = STATUS.DEGRADED;
    }
  } else if (!statusCode || statusCode >= 500) {
    health.status = STATUS.DEGRADED;
  } else {
    health.totalSuccess++;
    health.block403Count = 0;
    health.deadCount = 0;
    health.status = STATUS.HEALTHY;
  }

  await saveDomainHealth(domain, health);
}

async function getDomainStatus(website) {
  const domain = getDomain(website);
  if (!domain) return STATUS.DEAD;
  const health = await loadDomainHealth(domain);
  return health?.status || STATUS.HEALTHY;
}

async function markDomainDead(website, reason = "All crawl attempts failed") {
  const domain = getDomain(website);
  if (!domain) return;
  const health = (await loadDomainHealth(domain)) || { domain };
  health.status = STATUS.DEAD;
  health.deadReason = reason;
  health.markedDeadAt = new Date().toISOString();
  await saveDomainHealth(domain, health);
  console.warn(`💀 Marked DEAD: ${domain} — ${reason}`);
}

module.exports = {
  canCrawlUrl,
  recordCrawlResult,
  getDomainStatus,
  markDomainDead,
  getDomain,
  STATUS,
};
