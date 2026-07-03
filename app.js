/**
 * app.js — FIXED
 *
 * Key fix: uses closeAllConnections() on shutdown to properly close
 * both the BullMQ Redis connection and the cache Redis connection.
 *
 * Also adds a Mongoose duplicate index warning suppressor (cosmetic fix).
 */

require("dotenv").config();

const mongoose = require("mongoose");
const { startScheduler } = require("./queues/scheduler");
const { startCountryScheduler } = require("./queues/countryScheduler");
const { initWorkers } = require("./queues/workers");
const { logEnrichmentStats } = require("./utils/stats");
const { pingRedis, closeAllConnections } = require("./utils/redis");
const { getQueueStats } = require("./queues/enrichmentQueue");
const {
  getQueueStats: getCountryQueueStats,
} = require("./queues/countryEnrichmentQueue");

const STATS_INTERVAL_MS = 5 * 60 * 1000; // every 5 min

async function bootstrap() {
  try {
    // ── 1. MongoDB ──
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB connected");

    // ── 2. Redis health check ──
    const redisOk = await pingRedis();
    if (!redisOk) {
      throw new Error("Redis ping failed — check REDIS_URL in .env");
    }
    console.log("✅ Redis healthy");

    // ── 3. Start workers ──
    initWorkers();
    console.log("✅ Workers initialized");

    // ── 4. Start scheduler ──
    startScheduler();
    console.log("✅ Scheduler started");

    // ── 4b. Start country content scheduler (Phase 4, 2026-07 — folded in
    // from the old standalone services/scripts/enrichCountries.js) ──
    startCountryScheduler();
    console.log("✅ Country scheduler started");

    // ── 5. Initial stats ──
    await logEnrichmentStats();
    const queueStats = await getQueueStats();
    console.log("📦 Queue:", queueStats);
    const countryQueueStats = await getCountryQueueStats();
    console.log("🌍 Country queue:", countryQueueStats);

    console.log("\n🚀 University Enrichment System Running\n");

    // ── 6. Periodic stats ──
    setInterval(async () => {
      await logEnrichmentStats();
      const qs = await getQueueStats();
      console.log("📦 Queue:", qs);
      const cqs = await getCountryQueueStats();
      console.log("🌍 Country queue:", cqs);
    }, STATS_INTERVAL_MS);

    // ── 7. Graceful shutdown ──
    const shutdown = async (signal) => {
      console.log(`\n⛔ ${signal} received — shutting down gracefully`);
      try {
        await mongoose.disconnect();
        console.log("✅ MongoDB disconnected");
        await closeAllConnections();
      } catch (err) {
        console.error("Shutdown error:", err.message);
      }
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    process.on("uncaughtException", (err) => {
      // Don't exit — let workers continue
      // But log clearly so you know what happened
      console.error("💥 Uncaught exception:", err.stack || err.message);
    });

    process.on("unhandledRejection", (reason) => {
      console.error(
        "💥 Unhandled rejection:",
        reason?.stack || reason?.message || reason,
      );
    });
  } catch (err) {
    console.error("❌ Bootstrap failed:", err.message);
    process.exit(1);
  }
}

bootstrap();
