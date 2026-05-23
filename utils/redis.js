/**
 * redis.js — FIXED
 *
 * ROOT CAUSE OF "Command timed out":
 * ────────────────────────────────────
 * The single shared IORedis connection had commandTimeout: 5000ms.
 * BullMQ's internal lock-renewal Lua scripts run as EVALSHA commands.
 * Under concurrent load (4 workers × heavy crawl), Redis round-trips
 * spike past 5s → commandTimeout fires → "Command timed out" → worker crashes.
 *
 * FIXES:
 * 1. THREE separate connections:
 *    - bullmqConnection()  → for Worker/Queue (maxRetriesPerRequest: null, NO commandTimeout)
 *    - cacheConnection()   → for crawlCache / domainHealth / externalCache (with sane timeout)
 *    - getRedisConnection()→ general use / backwards compat (same as cache)
 *
 * 2. BullMQ connection MUST have maxRetriesPerRequest: null — this is required
 *    by BullMQ and documented in their README. Any other value causes silent failures.
 *
 * 3. commandTimeout removed from BullMQ connection entirely.
 *    BullMQ manages its own timeouts internally.
 *
 * 4. keepAlive raised to 60s to prevent NAT/firewall drops during long crawls.
 *
 * 5. enableOfflineQueue: false on BullMQ connection — if Redis is down,
 *    fail fast rather than queuing commands that will never execute.
 */

const IORedis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ─────────────────────────────────────────────
// Shared connection instances
// ─────────────────────────────────────────────
let _bullmqConn = null;
let _cacheConn = null;

// ─────────────────────────────────────────────
// BullMQ connection — ZERO commandTimeout, maxRetriesPerRequest: null
// This is the ONLY connection that should be passed to Worker/Queue
// ─────────────────────────────────────────────
function getBullMQConnection() {
  if (_bullmqConn && _bullmqConn.status === "ready") return _bullmqConn;

  _bullmqConn = new IORedis(REDIS_URL, {
    // REQUIRED by BullMQ — do NOT change this
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    // NO commandTimeout — BullMQ Lua scripts can take variable time
    // Setting this causes the exact "Command timed out" error you're seeing

    connectTimeout: 10000,
    keepAlive: 60000,

    // BullMQ needs offline queue OFF so it detects disconnects immediately
    enableOfflineQueue: false,

    lazyConnect: false,

    retryStrategy(times) {
      if (times > 20) {
        console.error(
          "❌ BullMQ Redis: too many reconnect attempts, giving up",
        );
        return null; // stop retrying — let BullMQ handle it
      }
      const delay = Math.min(200 * Math.pow(1.5, times), 10000);
      console.warn(
        `⚠️ BullMQ Redis reconnect #${times} — waiting ${Math.round(delay)}ms`,
      );
      return delay;
    },

    reconnectOnError(err) {
      const retryErrors = [
        "READONLY",
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
      ];
      return retryErrors.some((e) => err.message.includes(e));
    },
  });

  _bullmqConn.on("connect", () => console.log("✅ BullMQ Redis connected"));
  _bullmqConn.on("ready", () => console.log("✅ BullMQ Redis ready"));
  _bullmqConn.on("error", (err) => {
    // Don't crash on Redis errors — BullMQ will handle reconnect
    if (!err.message.includes("ECONNREFUSED")) {
      console.error("❌ BullMQ Redis error:", err.message);
    }
  });
  _bullmqConn.on("close", () => console.warn("⚠️ BullMQ Redis closed"));
  _bullmqConn.on("reconnecting", () =>
    console.log("🔄 BullMQ Redis reconnecting..."),
  );

  return _bullmqConn;
}

// ─────────────────────────────────────────────
// Cache connection — used by crawlCache, domainHealth, externalCache
// Has commandTimeout since these are short GET/SET operations
// ─────────────────────────────────────────────
function getCacheConnection() {
  if (_cacheConn && _cacheConn.status === "ready") return _cacheConn;

  _cacheConn = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,

    // 8s command timeout for cache ops — generous but not infinite
    commandTimeout: 8000,
    connectTimeout: 10000,
    keepAlive: 60000,

    enableOfflineQueue: true, // OK for cache — queue and retry

    retryStrategy(times) {
      if (times > 10) return null;
      return Math.min(500 * times, 5000);
    },

    reconnectOnError(err) {
      return ["READONLY", "ECONNRESET", "ETIMEDOUT"].some((e) =>
        err.message.includes(e),
      );
    },
  });

  _cacheConn.on("connect", () => console.log("✅ Cache Redis connected"));
  _cacheConn.on("ready", () => console.log("✅ Cache Redis ready"));
  _cacheConn.on("error", (err) => {
    if (!err.message.includes("ECONNREFUSED")) {
      console.error("❌ Cache Redis error:", err.message);
    }
  });

  return _cacheConn;
}

// ─────────────────────────────────────────────
// General-purpose connection (backwards compat)
// Points to cache connection — safe for app-level use
// ─────────────────────────────────────────────
function getRedisConnection() {
  return getCacheConnection();
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
async function pingRedis() {
  try {
    const conn = getCacheConnection();
    const result = await conn.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────
async function closeAllConnections() {
  const closing = [];
  if (_bullmqConn) closing.push(_bullmqConn.quit().catch(() => {}));
  if (_cacheConn) closing.push(_cacheConn.quit().catch(() => {}));
  await Promise.all(closing);
  console.log("✅ All Redis connections closed");
}

module.exports = {
  getRedisConnection, // general use / backwards compat
  getCacheConnection, // explicit cache use
  getBullMQConnection, // ONLY for Worker/Queue
  pingRedis,
  closeAllConnections,
};
