/**
 * extractUniversityData.js — Multi-Provider Upgrade
 *
 * Key changes from single-provider version:
 * - Uses multiProviderClient instead of single NVIDIA client
 * - Tries Tier 1 → Tier 2 → Tier 3 models across ALL providers
 * - SEO post-processor: upgrades thin descriptions to production quality
 * - Country name normalizer: "USA" → "United States" etc.
 * - Smarter content preprocessor for multilingual content
 * - HuggingFace gets a simplified prompt (smaller context window)
 */

const {
  callModel,
  getModelsForExtraction,
  recordModelSuccess,
  recordModelFailure,
} = require("./multiProviderClient");

const {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
} = require("./prompts/extractionPrompt");

const {
  getCachedExtraction,
  cacheExtraction,
  computeContentHash,
} = require("../utils/crawlCache");

const MODEL_TIMEOUT_MS = 45000;
const MAX_CONTENT_CHARS = 22000;
const CHUNK_THRESHOLD = 32000;
const CHUNK_SIZE = 16000;

// ─────────────────────────────────────────────
// Country name normalization — fixes AI abbreviation habits
// ─────────────────────────────────────────────
const COUNTRY_NORMALIZE = {
  usa: "United States",
  "u.s.a.": "United States",
  "u.s.": "United States",
  us: "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  uae: "United Arab Emirates",
  "south korea": "South Korea",
  "republic of korea": "South Korea",
  russia: "Russia",
  "russian federation": "Russia",
  china: "China",
  "people's republic of china": "China",
  czechia: "Czech Republic",
  "czech rep": "Czech Republic",
};

function normalizeCountry(country) {
  if (!country) return country;
  const key = country.trim().toLowerCase();
  return COUNTRY_NORMALIZE[key] || country.trim();
}

// ─────────────────────────────────────────────
// SEO description upgrader
// Ensures the description meets production quality standards
// ─────────────────────────────────────────────
function upgradeDescription(description, universityName, data) {
  if (!description) return buildMinimalDescription(universityName, data);

  const desc = description.trim();

  // If too short, rebuild
  if (desc.length < 80) return buildMinimalDescription(universityName, data);

  // If it doesn't mention the university name, prepend it
  const nameWords = universityName.split(/\s+/).slice(0, 2).join(" ");
  if (!desc.toLowerCase().includes(nameWords.toLowerCase())) {
    return buildMinimalDescription(universityName, data);
  }

  // Truncate to 800 chars max
  return desc.slice(0, 800);
}

function buildMinimalDescription(universityName, data) {
  const parts = [];

  const type = guessInstitutionType(universityName, data);
  parts.push(`${universityName} is a ${type}`);

  if (data.city && data.country) {
    parts.push(`located in ${data.city}, ${data.country}`);
  } else if (data.country) {
    parts.push(`located in ${data.country}`);
  }

  if (data.programs?.length >= 2) {
    const cats = [
      ...new Set(data.programs.slice(0, 3).map((p) => p.category)),
    ].join(", ");
    parts.push(`offering programs in ${cats}`);
  }

  const levels = data.programs?.length
    ? [...new Set(data.programs.map((p) => p.level.toLowerCase()))]
        .slice(0, 2)
        .join(" and ")
    : null;
  if (levels) parts.push(`at the ${levels} level`);

  parts.push("committed to academic excellence and student success.");

  return parts.join(", ").replace(", committed", ". It is committed") + "";
}

function guessInstitutionType(name, data) {
  const n = name.toLowerCase();
  if (n.includes("community college") || n.includes("technical college"))
    return "community college";
  if (n.includes("institute of technology") || n.includes("polytechnic"))
    return "technical institute";
  if (n.includes("college") && !n.includes("university")) return "college";
  if (n.includes("academy")) return "academy";
  if (n.includes("school of")) return "specialized school";
  if (n.includes("seminary")) return "seminary";
  return "university";
}

// ─────────────────────────────────────────────
// Content preprocessor — score and deduplicate sections
// ─────────────────────────────────────────────
function preprocessContent(content) {
  if (!content || content.length < 50) return content || "";

  const sections = content.split(/\[(?:PAGE|SECTION|EXTERNAL[^\]]*)\s*\d*\]/);

  const scored = sections
    .map((text) => {
      const t = text.trim();
      if (!t || t.length < 40) return null;

      let score = 0;
      if (/admiss|apply|application/i.test(t)) score += 60;
      if (/tuition|fee|fees|cost|scholarship/i.test(t)) score += 50;
      if (/program|programme|course|curriculum|degree/i.test(t)) score += 40;
      if (/ielts|toefl|gpa|gre|gmat|requirement|eligib/i.test(t)) score += 40;
      if (/undergraduate|postgraduate|phd|master|bachelor/i.test(t))
        score += 30;
      if (/about|overview|founded|established|history|mission/i.test(t))
        score += 25;
      if (/department|faculty|school of|college of/i.test(t)) score += 20;
      if (/international|global|exchange/i.test(t)) score += 15;
      if (/research|publication|ranking/i.test(t)) score += 10;
      if (/news|event|blog|award|ceremony|announcement/i.test(t)) score -= 40;
      if (/login|register|cart|checkout|privacy|cookie/i.test(t)) score -= 50;

      return { text: t, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // Deduplicate similar sections
  const deduped = [];
  for (const item of scored) {
    const isDupe = deduped.some(
      (ex) => computeTextOverlap(ex.text, item.text) > 0.65,
    );
    if (!isDupe) deduped.push(item);
    if (deduped.length >= 8) break; // max 8 unique sections
  }

  return deduped
    .map((item, i) => `[SECTION ${i + 1}]\n${item.text}`)
    .join("\n\n---\n\n");
}

function computeTextOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).slice(0, 80));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).slice(0, 80));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size, 1);
}

// ─────────────────────────────────────────────
// JSON parser — robust, handles model quirks
// ─────────────────────────────────────────────
function parseJsonResponse(raw) {
  if (!raw) return null;

  let text = raw.trim();
  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/m, "");

  // Direct parse
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Extract JSON object
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let jsonStr = match[0];

  // Fix trailing commas
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(jsonStr);
  } catch (_) {}

  // Balance brackets
  try {
    const ob = (jsonStr.match(/\{/g) || []).length;
    const cb = (jsonStr.match(/\}/g) || []).length;
    const obrk = (jsonStr.match(/\[/g) || []).length;
    const cbrk = (jsonStr.match(/\]/g) || []).length;
    let fixed = jsonStr;
    for (let i = 0; i < obrk - cbrk; i++) fixed += "]";
    for (let i = 0; i < ob - cb; i++) fixed += "}";
    return JSON.parse(fixed);
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
// Sanitize extracted data
// ─────────────────────────────────────────────
function sanitizeExtractedData(data) {
  if (!data || typeof data !== "object") return null;

  // QS ranking
  let qsRanking = data.qsRanking;
  if (typeof qsRanking === "string") {
    const n = parseInt(qsRanking.replace(/[^0-9]/g, ""));
    qsRanking = isNaN(n) || n < 1 || n > 1500 ? null : n;
  }
  if (typeof qsRanking !== "number" || qsRanking < 1 || qsRanking > 1500)
    qsRanking = null;

  // Acceptance rate
  let acceptanceRate = data.acceptanceRate;
  if (typeof acceptanceRate === "string") {
    const n = parseFloat(acceptanceRate.replace(/[^0-9.]/g, ""));
    acceptanceRate = isNaN(n) ? null : n;
  }
  if (
    typeof acceptanceRate === "number" &&
    acceptanceRate > 0 &&
    acceptanceRate < 1
  ) {
    acceptanceRate = acceptanceRate * 100;
  }
  if (
    typeof acceptanceRate !== "number" ||
    acceptanceRate < 0.5 ||
    acceptanceRate > 100
  ) {
    acceptanceRate = null;
  }

  // Programs
  const VALID_LEVELS = [
    "Undergraduate",
    "Postgraduate",
    "PhD",
    "Diploma",
    "Certificate",
  ];
  const INVALID_CATS = [
    "full-time",
    "part-time",
    "online",
    "distance",
    "blended",
    "hybrid",
    "n/a",
    "other",
    "various",
  ];

  const programs = Array.isArray(data.programs)
    ? data.programs
        .filter((p) => p?.category && p?.level)
        .filter((p) => VALID_LEVELS.includes(p.level))
        .filter(
          (p) =>
            !INVALID_CATS.includes(String(p.category).toLowerCase().trim()),
        )
        .filter((p) => String(p.category).trim().length >= 3)
        .map((p) => ({
          category: String(p.category).trim().slice(0, 120),
          level: p.level,
        }))
        .filter(
          (p, i, self) =>
            i ===
            self.findIndex(
              (x) => x.category === p.category && x.level === p.level,
            ),
        )
    : [];

  return {
    description:
      typeof data.description === "string" &&
      data.description.trim().length > 30
        ? data.description.trim().slice(0, 800)
        : null,
    city:
      typeof data.city === "string" && data.city.trim().length > 1
        ? data.city.trim().slice(0, 100)
        : null,
    country: normalizeCountry(
      typeof data.country === "string" ? data.country : null,
    ),
    qsRanking,
    acceptanceRate,
    totalStudents:
      typeof data.totalStudents === "string"
        ? data.totalStudents.trim().slice(0, 50)
        : null,
    tuitionFee:
      typeof data.tuitionFee === "string" && data.tuitionFee.trim().length > 3
        ? data.tuitionFee.trim().slice(0, 200)
        : null,
    studentsPlaced:
      typeof data.studentsPlaced === "number" && data.studentsPlaced >= 0
        ? data.studentsPlaced
        : null,
    intakes: Array.isArray(data.intakes)
      ? [
          ...new Set(
            data.intakes.filter((i) => i && String(i).length > 2).map(String),
          ),
        ].slice(0, 6)
      : [],
    admissionRequirements: Array.isArray(data.admissionRequirements)
      ? [
          ...new Set(
            data.admissionRequirements
              .filter((r) => r && String(r).length > 5)
              .map(String),
          ),
        ].slice(0, 10)
      : [],
    programs,
    similarUniversities: Array.isArray(data.similarUniversities)
      ? [
          ...new Set(data.similarUniversities.filter(Boolean).map(String)),
        ].slice(0, 8)
      : [],
    imageUrls: Array.isArray(data.imageUrls)
      ? data.imageUrls
          .filter((u) => {
            try {
              new URL(u);
              return String(u).startsWith("http");
            } catch {
              return false;
            }
          })
          .slice(0, 30)
      : [],
  };
}

// ─────────────────────────────────────────────
// Ensure minimum viable fields after extraction
// ─────────────────────────────────────────────
function ensureMinimumFields(data, universityName, websiteUrl) {
  if (!data) return data;

  // Normalize country
  if (data.country) data.country = normalizeCountry(data.country);

  // Infer country from TLD if missing
  if (!data.country) {
    try {
      const tld = new URL(websiteUrl).hostname.split(".").pop().toLowerCase();
      const TLD_COUNTRY = {
        edu: "United States",
        gr: "Greece",
        uk: "United Kingdom",
        in: "India",
        au: "Australia",
        ca: "Canada",
        de: "Germany",
        fr: "France",
        it: "Italy",
        es: "Spain",
        nl: "Netherlands",
        pt: "Portugal",
        br: "Brazil",
        mx: "Mexico",
        jp: "Japan",
        cn: "China",
        kr: "South Korea",
        sg: "Singapore",
        nz: "New Zealand",
        za: "South Africa",
        ng: "Nigeria",
        pk: "Pakistan",
        bd: "Bangladesh",
        lk: "Sri Lanka",
        mm: "Myanmar",
        th: "Thailand",
        vn: "Vietnam",
        ph: "Philippines",
        id: "Indonesia",
        my: "Malaysia",
        tr: "Turkey",
        ru: "Russia",
        pl: "Poland",
        cz: "Czech Republic",
        ro: "Romania",
        bg: "Bulgaria",
        hu: "Hungary",
        ua: "Ukraine",
        se: "Sweden",
        no: "Norway",
        dk: "Denmark",
        fi: "Finland",
        be: "Belgium",
        ch: "Switzerland",
        at: "Austria",
        ie: "Ireland",
      };
      if (TLD_COUNTRY[tld]) {
        data.country = TLD_COUNTRY[tld];
      }
    } catch (_) {}
  }

  // Upgrade description to SEO quality
  data.description = upgradeDescription(data.description, universityName, data);

  // Ensure minimum admission requirements
  if (!data.admissionRequirements || data.admissionRequirements.length < 2) {
    const isEnglishCountry = [
      "United States",
      "United Kingdom",
      "Australia",
      "Canada",
      "New Zealand",
      "Ireland",
    ].includes(data.country);
    data.admissionRequirements = isEnglishCountry
      ? [
          "Completed online application form",
          "Official academic transcripts from all previous institutions",
          "Proof of English language proficiency (IELTS/TOEFL)",
          "Two letters of recommendation",
          "Personal statement or statement of purpose",
        ]
      : [
          "Completed application form with required documents",
          "Official academic transcripts and certificates",
          "English language proficiency test results (IELTS 6.0 or TOEFL 80)",
          "Passport copy or national ID",
          "Statement of purpose",
        ];
  }

  // Ensure minimum intakes
  if (!data.intakes || data.intakes.length === 0) {
    const countryIntakes = {
      "United States": ["Fall", "Spring"],
      Canada: ["Fall", "Winter"],
      "United Kingdom": ["September", "January"],
      Australia: ["February", "July"],
      India: ["July", "January"],
      Brazil: ["March", "August"],
      Bulgaria: ["September", "February"],
      Myanmar: ["December", "June"],
    };
    data.intakes = countryIntakes[data.country] || ["September", "January"];
  }

  return data;
}

// ─────────────────────────────────────────────
// Single extraction attempt with one model
// ─────────────────────────────────────────────
async function runSingleExtraction(
  content,
  universityName,
  websiteUrl,
  modelEntry,
) {
  const prompt = buildExtractionPrompt(content, universityName, websiteUrl);

  // HuggingFace needs shorter prompts
  const maxTokens = modelEntry.provider === "huggingface" ? 800 : 2000;

  console.log(`🤖 Extraction model: ${modelEntry.id}`);

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
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length < 3) {
    throw new Error("Empty or invalid extraction result");
  }

  const sanitized = sanitizeExtractedData(parsed);
  if (!sanitized) throw new Error("Sanitization failed");

  sanitized._model = modelEntry.id;
  sanitized._provider = modelEntry.provider;

  return sanitized;
}

// ─────────────────────────────────────────────
// Main extraction — tries all providers in priority order
// ─────────────────────────────────────────────
async function runExtraction(content, universityName, websiteUrl) {
  const models = getModelsForExtraction([1, 2, 3]);

  if (models.length === 0) {
    throw new Error("No AI models available across any provider");
  }

  let lastError = null;

  for (const modelEntry of models) {
    try {
      const result = await runSingleExtraction(
        content,
        universityName,
        websiteUrl,
        modelEntry,
      );
      recordModelSuccess(modelEntry.id);
      console.log(`✅ Extracted via ${modelEntry.id}`);
      return result;
    } catch (err) {
      const msg = err.message || "";
      const isRateLimit =
        err.isRateLimit || msg.includes("429") || msg.includes("rate limit");
      const isTimeout = msg.includes("Timeout") || msg.includes("timeout");

      if (isRateLimit) {
        recordModelFailure(modelEntry.id, true, err.retryAfterMs || 60000);
      } else if (isTimeout) {
        console.warn(`⏱️ Extraction timeout [${modelEntry.id}]`);
        recordModelFailure(modelEntry.id, false);
      } else {
        console.warn(
          `❌ Extraction failed [${modelEntry.id}]: ${msg.slice(0, 100)}`,
        );
        recordModelFailure(modelEntry.id, false);
      }

      lastError = err;
      // Continue to next model
    }
  }

  throw lastError || new Error("All models failed extraction");
}

// ─────────────────────────────────────────────
// Chunked extraction for very long content
// ─────────────────────────────────────────────
async function extractInChunks(content, universityName, websiteUrl) {
  const chunks = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunk = content.slice(i, i + CHUNK_SIZE);
    if (chunk.trim().length > 100) chunks.push(chunk);
  }

  const results = [];
  for (let i = 0; i < Math.min(chunks.length, 3); i++) {
    try {
      const r = await runExtraction(chunks[i], universityName, websiteUrl);
      if (r) results.push(r);
    } catch (_) {}
  }

  if (results.length === 0) throw new Error("All chunks failed");
  return mergeExtractionResults(results);
}

// ─────────────────────────────────────────────
// Merge multiple extraction results
// ─────────────────────────────────────────────
function mergeExtractionResults(results = []) {
  if (!results.length) return {};

  const merged = {
    description: null,
    city: null,
    country: null,
    qsRanking: null,
    acceptanceRate: null,
    totalStudents: null,
    tuitionFee: null,
    studentsPlaced: null,
    intakes: [],
    admissionRequirements: [],
    programs: [],
    similarUniversities: [],
    imageUrls: [],
    _models: [],
  };

  const scalarFields = [
    "city",
    "country",
    "qsRanking",
    "acceptanceRate",
    "totalStudents",
    "tuitionFee",
    "studentsPlaced",
  ];

  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    if (result._model) merged._models.push(result._model);

    // Take longest description
    if (
      result.description &&
      typeof result.description === "string" &&
      result.description.length > 60
    ) {
      if (
        !merged.description ||
        result.description.length > merged.description.length
      ) {
        merged.description = result.description;
      }
    }

    for (const field of scalarFields) {
      if (merged[field] == null && result[field] != null)
        merged[field] = result[field];
    }

    if (Array.isArray(result.intakes)) merged.intakes.push(...result.intakes);
    if (Array.isArray(result.admissionRequirements))
      merged.admissionRequirements.push(...result.admissionRequirements);
    if (Array.isArray(result.programs))
      merged.programs.push(...result.programs);
    if (Array.isArray(result.similarUniversities))
      merged.similarUniversities.push(...result.similarUniversities);
    if (Array.isArray(result.imageUrls))
      merged.imageUrls.push(...result.imageUrls);
  }

  merged.intakes = [...new Set(merged.intakes.filter(Boolean))];
  merged.admissionRequirements = [
    ...new Set(merged.admissionRequirements.filter(Boolean)),
  ];
  merged.similarUniversities = [
    ...new Set(merged.similarUniversities.filter(Boolean)),
  ];
  merged.imageUrls = [...new Set(merged.imageUrls.filter(Boolean))].slice(
    0,
    30,
  );
  merged.programs = merged.programs.filter(
    (p, i, self) =>
      p?.category &&
      p?.level &&
      i ===
        self.findIndex((x) => x.category === p.category && x.level === p.level),
  );
  merged._models = [...new Set(merged._models)];

  return merged;
}

// ─────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────
async function extractUniversityData(
  websiteContent,
  universityName,
  websiteUrl,
  universityId,
) {
  if (!websiteContent || websiteContent.trim().length < 20) {
    throw new Error("Insufficient content for extraction");
  }

  const processed = preprocessContent(websiteContent);
  const content = (
    processed && processed.length > 50 ? processed : websiteContent
  ).slice(0, MAX_CONTENT_CHARS);

  // Cache check
  if (universityId) {
    const contentHash = computeContentHash(content);
    const cached = await getCachedExtraction(universityId, contentHash);
    if (cached) {
      console.log(`💾 Extraction cache hit for ${universityName}`);
      return cached;
    }
  }

  let result;

  if (content.length > CHUNK_THRESHOLD) {
    result = await extractInChunks(content, universityName, websiteUrl);
  } else {
    result = await runExtraction(content, universityName, websiteUrl);
  }

  // Post-process: ensure minimum fields and SEO quality
  result = ensureMinimumFields(result, universityName, websiteUrl);

  // Cache result
  if (universityId && result) {
    const contentHash = computeContentHash(content);
    await cacheExtraction(universityId, contentHash, result);
  }

  return result;
}

module.exports = {
  extractUniversityData,
  mergeExtractionResults,
  parseJsonResponse,
  sanitizeExtractedData,
  normalizeCountry,
};
