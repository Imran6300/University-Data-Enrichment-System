/**
 * enrichmentWorker.js — FIXED
 *
 * ROOT CAUSE FIXES (in priority order):
 *
 * FIX #1 — CRITICAL: Worker uses getBullMQConnection() not getRedisConnection()
 *   The old shared connection had commandTimeout: 5000ms.
 *   BullMQ's extendLock() runs a Lua EVALSHA — under load this takes >5s → timeout.
 *   getBullMQConnection() has NO commandTimeout → problem solved.
 *
 * FIX #2 — CRITICAL: Lock renewal uses try/catch with both BullMQ v4 + v5 signatures
 *   and suppresses the "Command timed out" error since it's non-fatal for the job.
 *   The job has a 15-min lock and we renew every 60s — 15 renewals before stall.
 *
 * FIX #3 — IMPORTANT: Concurrency set to 2 for free AI model targets.
 *   Target: 500 unis / 16 hours = 31.25/hour = 1 every ~115s
 *   With concurrency=2 and avg 90s/job: ~80/hour (safely above target, rate-limited by AI)
 *   Set WORKER_CONCURRENCY=3 in .env if AI models respond faster.
 *
 * FIX #4: Job-level timeout raised to 15min (was 12min).
 *   With concurrency=2 and Playwright semaphore=2, no queuing — each job gets
 *   immediate Playwright access. 15min is generous for 8 pages + AI extraction.
 *
 * FIX #5: crawlAttempts always incremented at job START (before any await).
 *   If the job times out, the increment already happened → dead domains stop
 *   being retried after 4 attempts.
 *
 * FIX #6: Throttle mechanism — adds a small delay between jobs to pace
 *   AI model requests and avoid 429s on free tier models.
 */

const { Worker } = require("bullmq");
const { QUEUE_NAME } = require("./../enrichmentQueue");
const { getBullMQConnection } = require("../../utils/redis"); // ← CRITICAL FIX

const University = require("../../models/universities");
const Country = require("../../models/countries");

const { discoverPages } = require("../../crawlers/pageDiscovery");
const { cheerioCrawl } = require("../../crawlers/cheerioCrawler");
const {
  playwrightCrawl,
  shouldUsePlawright,
} = require("../../crawlers/playwrightCrawler");
const { crawlSitemap } = require("../../crawlers/sitemapCrawler");
const {
  crawlExternalSources,
} = require("../../crawlers/externalSourceCrawler");

const { extractUniversityData } = require("../../ai/extractUniversityData");
const { validateUniversityData } = require("../../ai/validateUniversityData");
const {
  validateExtractedSchema,
} = require("../../validators/universityValidator");
const { processUniversityImages } = require("../../services/imageService");
const {
  getDomainStatus,
  markDomainDead,
  STATUS,
} = require("../../utils/domainHealth");

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

// Target: 500 unis / 16 hours = 31.25/hour
// With concurrency=2 and avg 90s/job → ~80/hour peak, but AI rate limits
// will naturally throttle to ~31/hour on free tier models.
// Set WORKER_CONCURRENCY=3 only if your free AI models handle load well.
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY) || 2;

const MAX_PAGES_TO_CRAWL = parseInt(process.env.MAX_PAGES_TO_CRAWL) || 8;
const CHEERIO_MIN_CONTENT = 300;
const GOOD_CONTENT_THRESHOLD = 4000;

// 15 minutes — generous budget with concurrency=2 (no Playwright queuing)
const PER_JOB_TIMEOUT_MS =
  parseInt(process.env.PER_JOB_TIMEOUT_MS) || 15 * 60 * 1000;

// Lock settings — lockDuration must be >> PER_JOB_TIMEOUT_MS
const LOCK_RENEW_INTERVAL_MS = 60 * 1000; // renew every 60s
const LOCK_DURATION_MS = 18 * 60 * 1000; // 18min lock > 15min job

// Throttle between job starts — prevents hammering AI models
// 2000ms between jobs with concurrency=2 → ~1 new job/second max start rate
const JOB_THROTTLE_MS = parseInt(process.env.JOB_THROTTLE_MS) || 2000;

const ENRICHED_THRESHOLD = 0.55;

const stats = {
  completed: 0,
  failed: 0,
  partial: 0,
  retries: 0,
  skipped: 0,
  startTime: Date.now(),
};

// ─────────────────────────────────────────────
// FIX #1: Lock renewal with correct BullMQ API + error suppression
//
// BullMQ v4: job.extendLock(token, duration)  — 2 args
// BullMQ v5: job.extendLock(duration)          — 1 arg
//
// The arity check (job.extendLock.length) is unreliable in some environments.
// We try v5 first, fall back to v4, and suppress "Command timed out" since
// the job has 18min of lock and we're renewing every 60s — even if 2-3
// renewals fail, the lock won't expire.
// ─────────────────────────────────────────────
function startLockRenewal(job) {
  let consecutiveFailures = 0;

  const interval = setInterval(async () => {
    try {
      // Try BullMQ v5 signature first (1 arg)
      await job.extendLock(LOCK_DURATION_MS);
      consecutiveFailures = 0;
    } catch (v5Err) {
      // If v5 failed, try v4 signature (2 args)
      try {
        await job.extendLock(job.token, LOCK_DURATION_MS);
        consecutiveFailures = 0;
      } catch (v4Err) {
        consecutiveFailures++;
        const msg = v4Err.message || v5Err.message || "";

        // Suppress transient errors (Command timed out, network blips)
        // Only warn if it's sustained (3+ consecutive failures)
        if (consecutiveFailures >= 3) {
          // Check if this is actually fatal
          if (msg.includes("Missing lock") || msg.includes("job not found")) {
            // Job was already completed or stolen — stop renewing
            clearInterval(interval);
          } else {
            console.warn(
              `⚠️ Lock renewal failing (${consecutiveFailures}x) for ${job.data?.universityName}: ${msg}`,
            );
          }
        }
        // Don't throw — lock renewal failure is non-fatal (18min lock, 60s interval)
      }
    }
  }, LOCK_RENEW_INTERVAL_MS);

  return () => clearInterval(interval);
}

// ─────────────────────────────────────────────
// Crawl one page: Cheerio → Playwright fallback
// ─────────────────────────────────────────────
async function crawlPage(url, totalContentSoFar) {
  let cheerioResult = null;

  try {
    cheerioResult = await cheerioCrawl(url);
  } catch (err) {
    const msg = err.message || "";
    if (
      msg.includes("404") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("Not Found") ||
      msg.includes("Gone")
    ) {
      return null;
    }
    // Other errors — fall through to Playwright attempt
  }

  const contentLen = cheerioResult?.cleanedText?.length || 0;

  // Skip Playwright if we already have enough total content
  if (totalContentSoFar >= GOOD_CONTENT_THRESHOLD) {
    return cheerioResult || null;
  }

  const needsPlaywright = await shouldUsePlawright(url, cheerioResult);

  if (needsPlaywright) {
    console.log(`📄 Playwright fallback (cheerio=${contentLen}c): ${url}`);
    try {
      const pwResult = await playwrightCrawl(url);
      if (pwResult && (pwResult.cleanedText?.length || 0) > contentLen) {
        return pwResult;
      }
    } catch (_) {}
  }

  return cheerioResult || null;
}

// ─────────────────────────────────────────────
// URL prioritization
// ─────────────────────────────────────────────
function prioritizeUrls(urls) {
  const score = (url) => {
    const l = url.toLowerCase();
    if (l.includes("admission")) return 100;
    if (l.includes("apply")) return 95;
    if (l.includes("tuition") || l.includes("fee")) return 90;
    if (l.includes("program") || l.includes("programme")) return 85;
    if (l.includes("course") || l.includes("curriculum")) return 80;
    if (l.includes("academic")) return 75;
    if (l.includes("undergraduate") || l.includes("btech")) return 70;
    if (
      l.includes("postgraduate") ||
      l.includes("master") ||
      l.includes("mtech")
    )
      return 65;
    if (l.includes("phd") || l.includes("doctoral")) return 65;
    if (l.includes("international")) return 55;
    if (l.includes("scholarship") || l.includes("requirement")) return 50;
    if (l.includes("about") || l.includes("overview")) return 35;
    if (l.includes("news") || l.includes("event") || l.includes("blog"))
      return -99;
    if (l.includes("staff") || l.includes("directory")) return -99;
    return 10;
  };

  return [...new Set(urls)]
    .map((url) => ({ url, score: score(url) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PAGES_TO_CRAWL)
    .map(({ url }) => url);
}

// ─────────────────────────────────────────────
// Adaptive crawl
// ─────────────────────────────────────────────
async function crawlPagesAdaptive(urls, job) {
  const results = [];
  let totalContent = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    if (totalContent >= GOOD_CONTENT_THRESHOLD && results.length >= 3) {
      console.log(
        `⚡ Adaptive stop: ${totalContent}c from ${results.length}/${urls.length} pages`,
      );
      break;
    }

    const result = await crawlPage(url, totalContent);
    if (result) {
      results.push(result);
      totalContent += result.cleanedText?.length || 0;
    }

    // Heartbeat
    try {
      const progress = 5 + Math.round((i / urls.length) * 30);
      await job.updateProgress(Math.min(progress, 35));
    } catch (_) {}
  }

  return results;
}

// ─────────────────────────────────────────────
// Multilingual detection
// ─────────────────────────────────────────────
function isNonEnglishContent(text) {
  if (!text || text.length < 100) return false;
  const sample = text.slice(0, 500);
  if (/[\u4e00-\u9fff]/.test(sample)) return true;
  if (/[\u0600-\u06ff]/.test(sample)) return true;
  if (/[\u0400-\u04ff]/.test(sample)) return true;
  return false;
}

// ─────────────────────────────────────────────
// Build failed reason
// ─────────────────────────────────────────────
function buildFailedReason(validation) {
  if (!validation) return "Validation failed";
  const issues = (validation.issues || []).filter(
    (i) => !i.includes("is null") && !i.toLowerCase().includes("missing"),
  );
  const hallucinations = validation.hallucinations || [];
  const all = [...issues, ...hallucinations];
  return all.length > 0 ? all.slice(0, 3).join("; ") : null;
}

// ─────────────────────────────────────────────
// Worker initialization — FIX #1: getBullMQConnection()
// ─────────────────────────────────────────────
function initEnrichmentWorker() {
  console.log(
    `👷 Enrichment worker: concurrency=${WORKER_CONCURRENCY} | target=~31/hour | timeout=${PER_JOB_TIMEOUT_MS / 60000}min`,
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Throttle: small delay between job starts to pace AI model requests
      if (JOB_THROTTLE_MS > 0) {
        await new Promise((r) => setTimeout(r, JOB_THROTTLE_MS));
      }

      if (job.attemptsMade > 0) stats.retries++;

      const { universityId, universityName, website } = job.data;
      const startedAt = Date.now();

      console.log(
        `\n🚀 [${universityName}] Starting enrichment (attempt ${job.attemptsMade + 1})`,
      );

      const stopLockRenewal = startLockRenewal(job);

      const jobTimeout = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Job timeout after ${PER_JOB_TIMEOUT_MS / 1000}s`),
            ),
          PER_JOB_TIMEOUT_MS,
        ),
      );

      try {
        return await Promise.race([
          processUniversity(
            job,
            universityId,
            universityName,
            website,
            startedAt,
          ),
          jobTimeout,
        ]);
      } finally {
        stopLockRenewal();
      }
    },
    {
      // CRITICAL FIX: Use dedicated BullMQ connection (no commandTimeout)
      connection: getBullMQConnection(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: 120 * 1000, // check stalled jobs every 2min
      maxStalledCount: 2, // allow 2 stalls before marking failed
    },
  );

  worker.on("completed", (job, result) => {
    const duration = job.finishedOn - job.processedOn;
    console.log(
      `✅ DONE: ${job.data.universityName} (${(duration / 1000).toFixed(0)}s | score=${result?.confidenceScore || "?"})`,
    );
    printStats();
  });

  worker.on("failed", (job, err) => {
    console.error(
      `❌ FAILED: ${job?.data?.universityName} — ${err.message} (attempt ${job?.attemptsMade})`,
    );
  });

  worker.on("error", (err) => {
    // "Command timed out" here means the BullMQ connection itself timed out
    // This should no longer happen with getBullMQConnection() (no commandTimeout)
    console.error("❌ Worker error:", err.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`⚠️ Job stalled: ${jobId}`);
  });

  process.on("SIGTERM", async () => {
    console.log("⛔ SIGTERM — closing worker gracefully");
    await worker.close();
    process.exit(0);
  });

  return worker;
}

// ─────────────────────────────────────────────
// Per-university processing
// ─────────────────────────────────────────────
async function processUniversity(
  job,
  universityId,
  universityName,
  website,
  startedAt,
) {
  // FIX #5: Always increment crawlAttempts FIRST — even a timeout counts
  await University.findByIdAndUpdate(universityId, {
    "enrichment.status": "processing",
    $inc: { "enrichment.crawlAttempts": 1 },
  });

  try {
    // ── STEP 0: Domain health check ──
    const domainStatus = await getDomainStatus(website);

    if (domainStatus === STATUS.DEAD) {
      console.log(
        `💀 [${universityName}] Domain dead — external-only enrichment`,
      );

      const externalMerged = await crawlExternalSources(universityName);

      if (externalMerged.description || externalMerged.country) {
        return await saveExternalOnlyEnrichment(
          universityId,
          universityName,
          website,
          externalMerged,
        );
      }

      await University.findByIdAndUpdate(universityId, {
        "enrichment.status": "failed",
        "enrichment.failedReason": "Domain dead — no external data found",
        "enrichment.crawlAttempts": 99,
        "enrichment.lastEnrichedAt": new Date(),
      });
      stats.skipped++;
      return { success: false, reason: "dead_domain" };
    }

    const domainBlocked = domainStatus === STATUS.BLOCKED;

    // ── STEP 1: Parallel discovery + external sources ──
    console.log(`🔍 [${universityName}] Discovering pages + external sources`);

    let sitemapPages = [];
    let discoveredPages = [];
    let externalMerged = {};

    if (domainBlocked) {
      console.log(`🚫 [${universityName}] Domain blocked — external-only`);
      externalMerged = await crawlExternalSources(universityName);
    } else {
      const [sitemapResult, discoveryResult, externalResult] =
        await Promise.allSettled([
          crawlSitemap(website),
          discoverPages(website),
          crawlExternalSources(universityName),
        ]);

      sitemapPages =
        sitemapResult.status === "fulfilled" ? sitemapResult.value : [];
      discoveredPages =
        discoveryResult.status === "fulfilled" ? discoveryResult.value : [];
      externalMerged =
        externalResult.status === "fulfilled" ? externalResult.value : {};
    }

    const rawUrls = [...new Set([...sitemapPages, ...discoveredPages])];
    const allUrls = prioritizeUrls(rawUrls);

    console.log(`📋 [${universityName}] Crawling ${allUrls.length} pages`);
    await job.updateProgress(15);

    // ── STEP 2: Adaptive crawl ──
    const crawlResults = domainBlocked
      ? []
      : await crawlPagesAdaptive(allUrls, job);

    console.log(
      `✅ [${universityName}] Crawled ${crawlResults.length}/${allUrls.length} pages`,
    );
    await job.updateProgress(40);

    // ── STEP 3: Build content ──
    const texts = crawlResults
      .map((r) => r.cleanedText?.trim())
      .filter((t) => t && t.length > 80);

    const isMultilingual = texts.some(isNonEnglishContent);
    if (isMultilingual) {
      console.log(`🌐 [${universityName}] Multilingual content detected`);
    }

    const sortedTexts = [...new Set(texts)].sort((a, b) => {
      const aVal = /admiss|tuition|fee|program|course/i.test(a) ? 1 : 0;
      const bVal = /admiss|tuition|fee|program|course/i.test(b) ? 1 : 0;
      return bVal - aVal;
    });

    const contentParts = [];

    if (externalMerged.description) {
      contentParts.push(
        `[EXTERNAL DESCRIPTION]\n${externalMerged.description}`,
      );
    }
    if (externalMerged.country || externalMerged.city) {
      contentParts.push(
        `[EXTERNAL LOCATION]\nCountry: ${externalMerged.country || "Unknown"}, City: ${externalMerged.city || "Unknown"}`,
      );
    }

    sortedTexts.forEach((t, i) => contentParts.push(`[PAGE ${i + 1}]\n${t}`));

    const combinedContent = contentParts.join("\n\n---\n\n").slice(0, 50000);

    const hasMinimumContent =
      combinedContent.length > 100 ||
      externalMerged.description ||
      externalMerged.country;

    if (!hasMinimumContent && crawlResults.length === 0) {
      await markDomainDead(website, "No pages crawled and no external data");
      throw new Error("No meaningful content from any source");
    }

    const contentForAI =
      combinedContent.trim() ||
      `[UNIVERSITY INFO]\nName: ${universityName}\nWebsite: ${website}\n${
        externalMerged.description
          ? `Description: ${externalMerged.description}`
          : ""
      }`;

    // ── STEP 4: AI extraction ──
    console.log(
      `🤖 [${universityName}] AI extraction (${contentForAI.length} chars)`,
    );

    const extracted = await extractUniversityData(
      contentForAI,
      universityName,
      website,
      universityId,
    );

    if (!extracted || typeof extracted !== "object") {
      throw new Error("AI extraction returned no data");
    }

    const imageUrls = [...new Set(crawlResults.flatMap((p) => p.images || []))];
    delete extracted.imageUrls;

    await job.updateProgress(65);

    // ── STEP 5: Merge extraction + external ──
    const merged = {
      description: null,
      country: null,
      city: null,
      tuitionFee: null,
      acceptanceRate: null,
      totalStudents: null,
      admissionRequirements: [],
      intakes: [],
      programs: [],
      ...externalMerged,
      ...extracted,
      description:
        extracted.description?.length > 80
          ? extracted.description
          : externalMerged.description || extracted.description,
      country: extracted.country || externalMerged.country,
      city: extracted.city || externalMerged.city,
      tuitionFee: extracted.tuitionFee || externalMerged.tuitionFee,
      acceptanceRate: extracted.acceptanceRate ?? externalMerged.acceptanceRate,
      totalStudents: extracted.totalStudents || externalMerged.totalStudents,
      admissionRequirements: [
        ...new Set([
          ...(extracted.admissionRequirements || []),
          ...(externalMerged.admissionRequirements || []),
        ]),
      ],
      intakes: [
        ...new Set([
          ...(extracted.intakes || []),
          ...(externalMerged.intakes || []),
        ]),
      ],
      programs: extracted.programs?.length
        ? extracted.programs
        : externalMerged.programs || [],
    };

    if (
      isMultilingual &&
      merged.description &&
      isNonEnglishContent(merged.description)
    ) {
      merged.description = externalMerged.description || null;
      console.log(
        `🌐 [${universityName}] Using external description (multilingual site)`,
      );
    }

    // ── STEP 6: Schema validation ──
    console.log(`📋 [${universityName}] Schema validation`);
    const schemaValidation = validateExtractedSchema(merged);

    if (!schemaValidation.success) {
      throw new Error(
        `Schema validation failed: ${schemaValidation.errors.slice(0, 3).join(", ")}`,
      );
    }

    // ── STEP 7: AI validation ──
    console.log(`🛡️ [${universityName}] AI validation`);
    const validation = await validateUniversityData(
      schemaValidation.data,
      universityName,
    );
    console.log(
      `📊 [${universityName}] Confidence: ${validation.confidenceScore}`,
    );

    await job.updateProgress(80);

    // ── STEP 8: Image processing ──
    console.log(
      `🖼️ [${universityName}] Processing images (${imageUrls.length} candidates)`,
    );
    const university = await University.findById(universityId);
    if (!university) throw new Error("University document not found");

    const imageResult = await processUniversityImages(
      imageUrls,
      university.slug,
    );
    await job.updateProgress(90);

    // ── STEP 9: Resolve country ──
    let countryId = university.country;
    let flagUrl = null;

    if (schemaValidation.data.country) {
      const countryDoc = await Country.findOne({
        name: new RegExp(`^${schemaValidation.data.country.trim()}$`, "i"),
      });

      if (countryDoc) {
        countryId = countryDoc._id;
        flagUrl = countryDoc.flagImage?.url || null;
      } else {
        const partialMatch = await Country.findOne({
          name: new RegExp(
            schemaValidation.data.country.trim().split(" ")[0],
            "i",
          ),
        });
        if (partialMatch) {
          countryId = partialMatch._id;
          flagUrl = partialMatch.flagImage?.url || null;
        } else {
          console.warn(
            `⚠️ Country not found: "${schemaValidation.data.country}"`,
          );
        }
      }
    }

    // ── STEP 10: Determine enrichment status ──
    const confidenceScore = validation.confidenceScore;
    let enrichmentStatus;
    let isEnriched;

    if (validation.status === "accept" || confidenceScore >= 0.72) {
      enrichmentStatus = "completed";
      isEnriched = true;
    } else if (
      validation.status === "partial" ||
      confidenceScore >= ENRICHED_THRESHOLD
    ) {
      enrichmentStatus = "partial";
      isEnriched = true;
    } else {
      enrichmentStatus = "failed";
      isEnriched = false;
    }

    // ── STEP 11: Save ──
    console.log(`💾 [${universityName}] Saving (status=${enrichmentStatus})`);

    const failedReason =
      enrichmentStatus === "failed" ? buildFailedReason(validation) : null;

    const saveData = {
      ...schemaValidation.data,
      country: countryId,
      ...(flagUrl ? { flag: flagUrl } : {}),
      logo: imageResult.logo || university.logo,
      images: Object.values(imageResult.images)
        .filter(Boolean)
        .map((img) => ({ url: img.url, public_id: img.public_id })),
      isEnriched,
      enrichment: {
        status: enrichmentStatus,
        confidenceScore,
        validated: validation.valid,
        sourceUrls: [
          ...allUrls,
          ...(externalMerged.externalSources || []).map((s) => s.source),
        ].slice(0, 30),
        lastEnrichedAt: new Date(),
        failedReason,
        domainBlocked: domainBlocked || false,
      },
    };

    await University.findByIdAndUpdate(universityId, saveData, {
      runValidators: false,
    });

    await job.updateProgress(100);

    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `🎉 [${universityName}] Done in ${duration}s — score=${confidenceScore} status=${enrichmentStatus}`,
    );

    if (enrichmentStatus === "completed") stats.completed++;
    else if (enrichmentStatus === "partial") stats.partial++;
    else stats.failed++;

    return { success: true, confidenceScore };
  } catch (err) {
    console.error(`❌ [${universityName}] Failed: ${err.message}`);

    await University.findByIdAndUpdate(universityId, {
      "enrichment.status": "failed",
      "enrichment.failedReason": err.message.slice(0, 500),
      "enrichment.lastEnrichedAt": new Date(),
    });

    stats.failed++;
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`⏱️ Failed after ${duration}s`);

    throw err;
  }
}

// ─────────────────────────────────────────────
// Save external-only enrichment
// ─────────────────────────────────────────────
async function saveExternalOnlyEnrichment(
  universityId,
  universityName,
  website,
  externalMerged,
) {
  try {
    const university = await University.findById(universityId);
    if (!university) return { success: false, reason: "not_found" };

    const data = {
      description: externalMerged.description || null,
      city: externalMerged.city || null,
      country: externalMerged.country || null,
      admissionRequirements: externalMerged.admissionRequirements?.length
        ? externalMerged.admissionRequirements
        : ["Application form required", "Academic transcripts required"],
      intakes: externalMerged.intakes?.length
        ? externalMerged.intakes
        : ["Fall Semester", "Spring Semester"],
      programs: externalMerged.programs || [],
    };

    const schemaResult = validateExtractedSchema(data);
    if (!schemaResult.success) {
      return { success: false, reason: "schema_failed" };
    }

    let countryId = university.country;
    if (data.country) {
      const countryDoc = await Country.findOne({
        name: new RegExp(`^${data.country.trim()}$`, "i"),
      });
      if (countryDoc) countryId = countryDoc._id;
    }

    const confidenceScore = data.description ? 0.58 : 0.5;

    await University.findByIdAndUpdate(
      universityId,
      {
        ...schemaResult.data,
        country: countryId,
        isEnriched: confidenceScore >= 0.55,
        "enrichment.status": "partial",
        "enrichment.confidenceScore": confidenceScore,
        "enrichment.validated": false,
        "enrichment.sourceUrls": (externalMerged.externalSources || []).map(
          (s) => s.source,
        ),
        "enrichment.lastEnrichedAt": new Date(),
        "enrichment.failedReason":
          "Domain dead — enriched from external sources only",
        "enrichment.crawlAttempts": 99,
      },
      { runValidators: false },
    );

    console.log(
      `💾 [${universityName}] External-only save (score=${confidenceScore})`,
    );
    stats.partial++;
    return { success: true, confidenceScore };
  } catch (err) {
    console.error(`❌ External-only save failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─────────────────────────────────────────────
// Stats printer
// ─────────────────────────────────────────────
function printStats() {
  const totalDone = stats.completed + stats.partial + stats.failed;
  const elapsedMin = (Date.now() - stats.startTime) / 1000 / 60;
  const speed = elapsedMin > 0 ? (totalDone / elapsedMin).toFixed(1) : "0";
  const perHour =
    elapsedMin > 0 ? Math.round((totalDone / elapsedMin) * 60) : 0;

  console.log(
    `📊 STATS │ ✅ ${stats.completed} │ ⚠️ ${stats.partial} │ ❌ ${stats.failed} │ 🔄 ${stats.retries} │ 💀 ${stats.skipped} │ ⚡ ${speed}/min (~${perHour}/hr)`,
  );
}

module.exports = { initEnrichmentWorker };
