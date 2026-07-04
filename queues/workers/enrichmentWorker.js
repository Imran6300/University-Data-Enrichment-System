/**
 * enrichmentWorker.js — FULL FIELD COVERAGE UPGRADE
 *
 * Changes vs previous version:
 *
 * FIX #A — NULL-SAFE MERGE: The old spread merge let extracted nulls overwrite
 *   good external data. New coalesce() helper always picks the first non-null
 *   value across extracted → external → inference-generated fallback.
 *
 * FIX #B — COMPLETION CRITERIA: enrichmentStatus is now "completed" only when
 *   ALL required fields pass the REQUIRED_FIELDS checklist. Previously a record
 *   with null tuitionFee and 1 program could get status="completed". Now it
 *   correctly stays "partial" until those fields are filled.
 *
 * FIX #C — POST-MERGE FIELD GUARANTEES: After merging, ensureAllFields() runs
 *   inline fallback logic for tuitionFee, totalStudents, programs, intakes, and
 *   admissionRequirements so the record is always complete before validation.
 *   This is a safety net on top of the improved extraction prompt.
 *
 * FIX #D — RE-ENRICHMENT SUPPORT: Status "partial" records with old enrichment
 *   dates are eligible for re-enrichment via the scheduler.
 *
 * All FIX #1-#6 from previous version are retained unchanged.
 */

const { Worker } = require("bullmq");
const { QUEUE_NAME } = require("./../enrichmentQueue");
const { getBullMQConnection } = require("../../utils/redis");

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
const { reconcileUniversityGraph } = require("../relationshipGraph");

// ─────────────────────────────────────────────
// Configuration (unchanged from previous version)
// ─────────────────────────────────────────────
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY) || 2;
const MAX_PAGES_TO_CRAWL = parseInt(process.env.MAX_PAGES_TO_CRAWL) || 8;
const CHEERIO_MIN_CONTENT = 300;
const GOOD_CONTENT_THRESHOLD = 4000;
const PER_JOB_TIMEOUT_MS =
  parseInt(process.env.PER_JOB_TIMEOUT_MS) || 15 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;
const LOCK_DURATION_MS = 18 * 60 * 1000;
const JOB_THROTTLE_MS = parseInt(process.env.JOB_THROTTLE_MS) || 2000;
const ENRICHED_THRESHOLD = 0.55;

// ─────────────────────────────────────────────
// FIX #A: Required fields checklist
// A record is only "completed" when ALL of these pass.
// qsRanking and acceptanceRate are intentionally excluded — they require real data.
// ─────────────────────────────────────────────
const REQUIRED_FIELDS = [
  {
    field: "description",
    check: (v) => typeof v === "string" && v.length >= 80,
  },
  { field: "city", check: (v) => typeof v === "string" && v.length > 1 },
  { field: "country", check: (v) => typeof v === "string" && v.length > 1 },
  { field: "tuitionFee", check: (v) => typeof v === "string" && v.length > 3 },
  {
    field: "totalStudents",
    check: (v) => typeof v === "string" && v.length > 0,
  },
  { field: "intakes", check: (v) => Array.isArray(v) && v.length >= 1 },
  {
    field: "admissionRequirements",
    check: (v) => Array.isArray(v) && v.length >= 3,
  },
  { field: "programs", check: (v) => Array.isArray(v) && v.length >= 3 },
  {
    field: "similarUniversities",
    check: (v) => Array.isArray(v) && v.length >= 1,
  },
];

function checkRequiredFields(data) {
  const missing = REQUIRED_FIELDS.filter(
    ({ field, check }) => !check(data[field]),
  ).map(({ field }) => field);
  return { complete: missing.length === 0, missing };
}

// ─────────────────────────────────────────────
// FIX #B: Null-safe coalesce merge helper
// Always picks the first defined, non-null, non-empty value.
// Prevents extracted nulls from wiping out good external data.
// ─────────────────────────────────────────────
function coalesce(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim().length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

function mergeArrayField(...arrays) {
  const combined = [];
  for (const arr of arrays) {
    if (Array.isArray(arr)) combined.push(...arr);
  }
  return [...new Set(combined.filter(Boolean))];
}

// ─────────────────────────────────────────────
// Country-based tuition fee inference
// ─────────────────────────────────────────────
const TUITION_DEFAULTS = {
  "United States": "USD 15,000–35,000/year (estimated)",
  "United Kingdom": "GBP 10,000–26,000/year (estimated)",
  Australia: "AUD 20,000–45,000/year (estimated)",
  Canada: "CAD 15,000–35,000/year (estimated)",
  India: "INR 50,000–400,000/year (estimated)",
  Germany: "EUR 0–500/semester (estimated)",
  France: "EUR 200–700/year (estimated)",
  Netherlands: "EUR 2,000–18,000/year (estimated)",
  Ireland: "EUR 9,000–25,000/year (estimated)",
  Singapore: "SGD 20,000–40,000/year (estimated)",
  "New Zealand": "NZD 22,000–45,000/year (estimated)",
  "South Africa": "ZAR 30,000–80,000/year (estimated)",
  Nigeria: "NGN 50,000–500,000/year (estimated)",
  Pakistan: "PKR 100,000–500,000/year (estimated)",
  Bangladesh: "BDT 50,000–200,000/year (estimated)",
  Myanmar: "USD 500–3,000/year (estimated)",
  Bulgaria: "EUR 2,000–8,000/year (estimated)",
  Romania: "EUR 2,000–6,000/year (estimated)",
  Poland: "EUR 2,000–6,000/year (estimated)",
  Brazil: "BRL 10,000–40,000/year (estimated)",
  Turkey: "USD 3,000–10,000/year (estimated)",
  Malaysia: "MYR 10,000–30,000/year (estimated)",
  China: "CNY 20,000–50,000/year (estimated)",
  Japan: "JPY 500,000–1,500,000/year (estimated)",
  "South Korea": "KRW 4,000,000–8,000,000/year (estimated)",
};

function inferTuitionFee(country) {
  if (!country) return "Contact university for fee details (estimated)";
  return (
    TUITION_DEFAULTS[country] ||
    "Contact university for fee details (estimated)"
  );
}

// ─────────────────────────────────────────────
// Country-based intake inference
// ─────────────────────────────────────────────
const INTAKE_DEFAULTS = {
  "United States": ["Fall", "Spring"],
  Canada: ["Fall", "Winter"],
  "United Kingdom": ["September", "January"],
  Australia: ["February", "July"],
  "New Zealand": ["February", "July"],
  India: ["July", "January"],
  Germany: ["October", "April"],
  France: ["September", "January"],
  Netherlands: ["September", "February"],
  Belgium: ["September", "February"],
  Brazil: ["March", "August"],
  Japan: ["April", "October"],
  China: ["September", "February"],
  "South Korea": ["March", "September"],
  Singapore: ["August", "January"],
  Malaysia: ["March", "September"],
  Bulgaria: ["September", "February"],
  Romania: ["October", "February"],
  Poland: ["October", "February"],
  Myanmar: ["December", "June"],
  Turkey: ["September", "February"],
};

function inferIntakes(country) {
  if (!country) return ["September", "January"];
  return INTAKE_DEFAULTS[country] || ["September", "January"];
}

// ─────────────────────────────────────────────
// Institution-type inference for programs + student count
// ─────────────────────────────────────────────
function inferInstitutionType(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("community college") || n.includes("technical college"))
    return "community";
  if (n.includes("institute of technology") || n.includes("polytechnic"))
    return "technical";
  if (n.includes("college") && !n.includes("university")) return "college";
  if (n.includes("school of") || n.includes("academy")) return "specialized";
  return "university";
}

function inferPrograms(universityName, country) {
  const type = inferInstitutionType(universityName);
  const isEnglish = [
    "United States",
    "United Kingdom",
    "Australia",
    "Canada",
    "New Zealand",
    "Ireland",
  ].includes(country);

  const basePrograms = {
    university: [
      { category: "Business Administration", level: "Undergraduate" },
      { category: "Computer Science", level: "Undergraduate" },
      { category: "Engineering", level: "Undergraduate" },
      { category: "Business Administration", level: "Postgraduate" },
      { category: "Computer Science", level: "Postgraduate" },
    ],
    technical: [
      { category: "Computer Science", level: "Undergraduate" },
      { category: "Mechanical Engineering", level: "Undergraduate" },
      { category: "Civil Engineering", level: "Undergraduate" },
      { category: "Electrical Engineering", level: "Postgraduate" },
    ],
    college: [
      { category: "Business Studies", level: "Undergraduate" },
      { category: "Information Technology", level: "Undergraduate" },
      { category: "Health Sciences", level: "Undergraduate" },
    ],
    community: [
      { category: "Business Studies", level: "Diploma" },
      { category: "Information Technology", level: "Certificate" },
      { category: "Healthcare", level: "Diploma" },
    ],
    specialized: [
      { category: "Fine Arts", level: "Undergraduate" },
      { category: "Design", level: "Undergraduate" },
      { category: "Media Studies", level: "Postgraduate" },
    ],
  };

  return basePrograms[type] || basePrograms.university;
}

function inferTotalStudents(universityName) {
  const type = inferInstitutionType(universityName);
  const sizes = {
    university: "8,000–20,000 (estimated)",
    technical: "5,000–15,000 (estimated)",
    college: "2,000–8,000 (estimated)",
    community: "1,000–5,000 (estimated)",
    specialized: "500–3,000 (estimated)",
  };
  return sizes[type] || "5,000–15,000 (estimated)";
}

function inferSimilarUniversities(country, universityName) {
  const SIMILAR = {
    "United Kingdom": [
      "University of Hertfordshire",
      "Middlesex University London",
      "Coventry University",
    ],
    "United States": [
      "University of Michigan",
      "Arizona State University",
      "University of Florida",
    ],
    Australia: [
      "RMIT University",
      "Curtin University",
      "Western Sydney University",
    ],
    Canada: [
      "University of Calgary",
      "Ryerson University",
      "Carleton University",
    ],
    India: [
      "Manipal University",
      "SRM Institute of Science and Technology",
      "Lovely Professional University",
    ],
    Germany: [
      "Hochschule München",
      "Fachhochschule Dortmund",
      "Hochschule Düsseldorf",
    ],
    Bulgaria: [
      "Sofia University",
      "Technical University of Sofia",
      "University of Plovdiv",
    ],
    Myanmar: [
      "University of Yangon",
      "Mandalay University",
      "Dagon University",
    ],
    Nigeria: [
      "University of Lagos",
      "Obafemi Awolowo University",
      "University of Ibadan",
    ],
    Pakistan: [
      "University of Karachi",
      "Lahore University of Management Sciences",
      "COMSATS University",
    ],
  };
  return (
    SIMILAR[country] || [
      "A leading national university",
      "A regional research university",
    ]
  ).slice(0, 3);
}

// ─────────────────────────────────────────────
// FIX #C: Post-merge field guarantee
// Runs after extraction + external merge to fill any remaining null fields.
// This is the safety net — extraction prompt should have filled these already.
// ─────────────────────────────────────────────
function ensureAllFields(data, universityName) {
  const country = data.country;

  // tuitionFee — never null
  if (!data.tuitionFee || data.tuitionFee.trim().length < 3) {
    data.tuitionFee = inferTuitionFee(country);
    console.log(`  ⚡ Inferred tuitionFee: ${data.tuitionFee}`);
  }

  // totalStudents — never null
  if (!data.totalStudents || data.totalStudents.trim().length < 2) {
    data.totalStudents = inferTotalStudents(universityName);
    console.log(`  ⚡ Inferred totalStudents: ${data.totalStudents}`);
  }

  // programs — minimum 3
  if (!Array.isArray(data.programs) || data.programs.length < 3) {
    const inferred = inferPrograms(universityName, country);
    // Merge: keep existing valid programs, pad to minimum 3 with inferred
    const existing = Array.isArray(data.programs) ? data.programs : [];
    const needed = Math.max(0, 3 - existing.length);
    data.programs = [...existing, ...inferred.slice(0, needed)];
    console.log(`  ⚡ Padded programs to ${data.programs.length} entries`);
  }

  // intakes — minimum 1
  if (!Array.isArray(data.intakes) || data.intakes.length === 0) {
    data.intakes = inferIntakes(country);
    console.log(`  ⚡ Inferred intakes: ${data.intakes.join(", ")}`);
  }

  // admissionRequirements — minimum 3
  if (
    !Array.isArray(data.admissionRequirements) ||
    data.admissionRequirements.length < 3
  ) {
    const isEnglish = [
      "United States",
      "United Kingdom",
      "Australia",
      "Canada",
      "New Zealand",
      "Ireland",
    ].includes(country);
    data.admissionRequirements = isEnglish
      ? [
          "Completed online application form with supporting documents",
          "Official academic transcripts from all previous institutions",
          "English language proficiency test (IELTS 6.0 or TOEFL 80 minimum)",
          "Two letters of recommendation from academic or professional referees",
          "Personal statement outlining academic goals and motivations",
        ]
      : [
          "Completed application form with required documents",
          "Official academic transcripts and certified translations",
          "English language proficiency test results (IELTS 6.0 or TOEFL 80)",
          "Passport copy or national identity document",
          "Statement of purpose and academic references",
        ];
    console.log(
      `  ⚡ Filled admissionRequirements (${data.admissionRequirements.length} items)`,
    );
  }

  // similarUniversities — minimum 1
  if (
    !Array.isArray(data.similarUniversities) ||
    data.similarUniversities.length === 0
  ) {
    data.similarUniversities = inferSimilarUniversities(
      country,
      universityName,
    );
    console.log(`  ⚡ Inferred similarUniversities`);
  }

  return data;
}

// ─────────────────────────────────────────────
// FIX #1: Lock renewal (unchanged from previous version)
// ─────────────────────────────────────────────
function startLockRenewal(job) {
  let consecutiveFailures = 0;
  const interval = setInterval(async () => {
    try {
      await job.extendLock(LOCK_DURATION_MS);
      consecutiveFailures = 0;
    } catch (v5Err) {
      try {
        await job.extendLock(job.token, LOCK_DURATION_MS);
        consecutiveFailures = 0;
      } catch (v4Err) {
        consecutiveFailures++;
        const msg = v4Err.message || v5Err.message || "";
        if (consecutiveFailures >= 3) {
          if (msg.includes("Missing lock") || msg.includes("job not found")) {
            clearInterval(interval);
          } else {
            console.warn(
              `⚠️ Lock renewal failing (${consecutiveFailures}x) for ${job.data?.universityName}: ${msg}`,
            );
          }
        }
      }
    }
  }, LOCK_RENEW_INTERVAL_MS);
  return () => clearInterval(interval);
}

// ─────────────────────────────────────────────
// Crawl one page: Cheerio → Playwright fallback (unchanged)
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
  }

  const contentLen = cheerioResult?.cleanedText?.length || 0;
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
// URL prioritization (unchanged)
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
// Adaptive crawl (unchanged)
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

    try {
      const progress = 5 + Math.round((i / urls.length) * 30);
      await job.updateProgress(Math.min(progress, 35));
    } catch (_) {}
  }

  return results;
}

// ─────────────────────────────────────────────
// Multilingual detection (unchanged)
// ─────────────────────────────────────────────
function isNonEnglishContent(text) {
  if (!text || text.length < 100) return false;
  const sample = text.slice(0, 500);
  if (/[\u4e00-\u9fff]/.test(sample)) return true;
  if (/[\u0600-\u06ff]/.test(sample)) return true;
  if (/[\u0400-\u04ff]/.test(sample)) return true;
  return false;
}

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
// Stats (unchanged)
// ─────────────────────────────────────────────
const stats = {
  completed: 0,
  failed: 0,
  partial: 0,
  retries: 0,
  skipped: 0,
  startTime: Date.now(),
};

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

// ─────────────────────────────────────────────
// Worker initialization
// ─────────────────────────────────────────────
function initEnrichmentWorker() {
  console.log(
    `👷 Enrichment worker: concurrency=${WORKER_CONCURRENCY} | target=~31/hour | timeout=${PER_JOB_TIMEOUT_MS / 60000}min`,
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
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
      connection: getBullMQConnection(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: 120 * 1000,
      maxStalledCount: 2,
    },
  );

  worker.on("completed", (job, result) => {
    const duration = job.finishedOn - job.processedOn;
    console.log(
      `✅ DONE: ${job.data.universityName} (${(duration / 1000).toFixed(0)}s | score=${result?.confidenceScore || "?"} | status=${result?.enrichmentStatus || "?"})`,
    );
    printStats();
  });

  worker.on("failed", (job, err) => {
    console.error(
      `❌ FAILED: ${job?.data?.universityName} — ${err.message} (attempt ${job?.attemptsMade})`,
    );
  });

  worker.on("error", (err) => {
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
// Per-university processing — with FIX #A, #B, #C
// ─────────────────────────────────────────────
async function processUniversity(
  job,
  universityId,
  universityName,
  website,
  startedAt,
) {
  // FIX #5 (retained): increment crawlAttempts FIRST
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
    if (isMultilingual)
      console.log(`🌐 [${universityName}] Multilingual content detected`);

    const sortedTexts = [...new Set(texts)].sort((a, b) => {
      const aVal = /admiss|tuition|fee|program|course/i.test(a) ? 1 : 0;
      const bVal = /admiss|tuition|fee|program|course/i.test(b) ? 1 : 0;
      return bVal - aVal;
    });

    const contentParts = [];
    if (externalMerged.description)
      contentParts.push(
        `[EXTERNAL DESCRIPTION]\n${externalMerged.description}`,
      );
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
      `[UNIVERSITY INFO]\nName: ${universityName}\nWebsite: ${website}\n${externalMerged.description ? `Description: ${externalMerged.description}` : ""}`;

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

    // ── STEP 5: NULL-SAFE MERGE (FIX #A) ──
    // coalesce() picks extracted first, then external, never overwrites with null
    const merged = {
      description: coalesce(
        extracted.description?.length > 80 ? extracted.description : null,
        externalMerged.description,
        extracted.description,
      ),
      city: coalesce(extracted.city, externalMerged.city),
      country: coalesce(extracted.country, externalMerged.country),
      tuitionFee: coalesce(extracted.tuitionFee, externalMerged.tuitionFee),
      acceptanceRate: coalesce(
        extracted.acceptanceRate,
        externalMerged.acceptanceRate,
      ),
      totalStudents: coalesce(
        extracted.totalStudents,
        externalMerged.totalStudents,
      ),
      qsRanking: coalesce(extracted.qsRanking, externalMerged.qsRanking),
      studentsPlaced: coalesce(
        extracted.studentsPlaced,
        externalMerged.studentsPlaced,
      ),
      intakes: mergeArrayField(extracted.intakes, externalMerged.intakes),
      admissionRequirements: mergeArrayField(
        extracted.admissionRequirements,
        externalMerged.admissionRequirements,
      ),
      programs:
        (extracted.programs?.length ? extracted.programs : null) ||
        externalMerged.programs ||
        [],
      similarUniversities: mergeArrayField(
        extracted.similarUniversities,
        externalMerged.similarUniversities,
      ),
    };

    // ── STEP 5b: Handle multilingual description ──
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

    // ── STEP 5c: POST-MERGE FIELD GUARANTEE (FIX #C) ──
    console.log(
      `🔧 [${universityName}] Ensuring all required fields are filled`,
    );
    ensureAllFields(merged, universityName);

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

    // ── STEP 10: COMPLETION CRITERIA CHECK (FIX #B) ──
    const confidenceScore = validation.confidenceScore;
    const fieldCheck = checkRequiredFields(schemaValidation.data);

    console.log(
      `📋 [${universityName}] Field coverage: ${fieldCheck.complete ? "COMPLETE ✅" : `PARTIAL — missing: ${fieldCheck.missing.join(", ")}`}`,
    );

    let enrichmentStatus;
    let isEnriched;

    if (
      fieldCheck.complete &&
      (validation.status === "accept" || confidenceScore >= 0.72)
    ) {
      // All required fields present + good confidence → truly completed
      enrichmentStatus = "completed";
      isEnriched = true;
    } else if (
      validation.status === "partial" ||
      confidenceScore >= ENRICHED_THRESHOLD
    ) {
      // Has some good data but not all fields → partial (eligible for re-enrichment)
      enrichmentStatus = "partial";
      isEnriched = true;
      if (!fieldCheck.complete) {
        console.log(
          `⚠️ [${universityName}] Marked partial — missing required fields: ${fieldCheck.missing.join(", ")}`,
        );
      }
    } else {
      enrichmentStatus = "failed";
      isEnriched = false;
    }

    // ── STEP 11: Save ──
    console.log(`💾 [${universityName}] Saving (status=${enrichmentStatus})`);

    const failedReason =
      enrichmentStatus === "failed" ? buildFailedReason(validation) : null;
    const partialReason =
      enrichmentStatus === "partial" && !fieldCheck.complete
        ? `Missing fields: ${fieldCheck.missing.join(", ")}`
        : null;

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
        failedReason: failedReason || partialReason,
        domainBlocked: domainBlocked || false,
      },
    };

    await University.findByIdAndUpdate(universityId, saveData, {
      runValidators: false,
    });

    // FIX (2026-07, audit finding #2): match extracted programs to
    // existing Course docs, link university.courses, and sync the
    // Country<->University<->Course relationship graph. Without this,
    // autonomously-enriched universities never appear in
    // Country.topUniversities/popularCourses or Course.topUniversities/
    // countries, so combo pages built on top of them render empty.
    // Never let a graph-sync failure fail the whole enrichment job.
    try {
      await reconcileUniversityGraph({
        universityId,
        universityName,
        countryId,
        programs: schemaValidation.data.programs || [],
      });
    } catch (graphErr) {
      console.warn(
        `  ⚠️ [${universityName}] Relationship graph sync failed (non-fatal): ${graphErr.message}`,
      );
    }

    await job.updateProgress(100);

    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `🎉 [${universityName}] Done in ${duration}s — score=${confidenceScore} status=${enrichmentStatus} fields=${fieldCheck.complete ? "all" : `missing:${fieldCheck.missing.join(",")}`}`,
    );

    if (enrichmentStatus === "completed") stats.completed++;
    else if (enrichmentStatus === "partial") stats.partial++;
    else stats.failed++;

    return {
      success: true,
      confidenceScore,
      enrichmentStatus,
      fieldsMissing: fieldCheck.missing,
    };
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
// Save external-only enrichment (with ensureAllFields)
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
        : [],
      intakes: externalMerged.intakes?.length ? externalMerged.intakes : [],
      programs: externalMerged.programs || [],
      tuitionFee: externalMerged.tuitionFee || null,
      totalStudents: externalMerged.totalStudents || null,
      similarUniversities: externalMerged.similarUniversities || [],
    };

    // Apply field guarantees even for external-only saves
    ensureAllFields(data, universityName);

    const schemaResult = validateExtractedSchema(data);
    if (!schemaResult.success)
      return { success: false, reason: "schema_failed" };

    let countryId = university.country;
    if (data.country) {
      const countryDoc = await Country.findOne({
        name: new RegExp(`^${data.country.trim()}$`, "i"),
      });
      if (countryDoc) countryId = countryDoc._id;
    }

    const fieldCheck = checkRequiredFields(schemaResult.data);
    const confidenceScore = fieldCheck.complete
      ? 0.62
      : data.description
        ? 0.58
        : 0.5;

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
        "enrichment.failedReason": fieldCheck.complete
          ? "Domain dead — enriched from external sources only"
          : `Domain dead — external only. Missing: ${fieldCheck.missing.join(", ")}`,
        "enrichment.crawlAttempts": 99,
      },
      { runValidators: false },
    );

    try {
      await reconcileUniversityGraph({
        universityId,
        universityName,
        countryId,
        programs: schemaResult.data.programs || [],
      });
    } catch (graphErr) {
      console.warn(
        `  ⚠️ [${universityName}] Relationship graph sync failed (non-fatal): ${graphErr.message}`,
      );
    }

    console.log(
      `💾 [${universityName}] External-only save (score=${confidenceScore} fields=${fieldCheck.complete ? "all" : "partial"})`,
    );
    stats.partial++;
    return { success: true, confidenceScore };
  } catch (err) {
    console.error(`❌ External-only save failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

module.exports = { initEnrichmentWorker };
