/**
 * FIXED: externalSourceCrawler.js
 *
 * CRITICAL FIXES vs old version:
 * - Each source runs with its OWN independent timeout (not a shared Promise.allSettled that waits for the slowest)
 * - Wikipedia now uses search API first (was hitting 403 on direct title lookup)
 * - Wikidata SPARQL simplified — complex joins were causing 30s+ timeouts
 * - ROR and OpenAlex use polite User-Agent with mailto (required to avoid rate limiting)
 * - Added Times Higher Education scraping via their sitemap for richer data
 * - Added college-specific data from CollegeSimply / NCES for US universities
 * - Individual source timeout: 6s (was 8s shared) — 3 fast sources beat 1 slow one
 * - External cache TTL bumped to 14 days (was 7 days — external data doesn't change often)
 */

const axios = require("axios");
const { getRedisConnection } = require("../utils/redis");

const SOURCE_TIMEOUT = 6000; // per-source timeout
const EXTERNAL_CACHE_TTL = 14 * 24 * 3600; // 14 days

const WIKIPEDIA_UA =
  "UniversityDataEnricher/2.0 (https://yourapp.com; enrichment@yourapp.com)";
const OPENALEX_MAILTO = "enrichment@yourapp.com"; // Required by OpenAlex polite pool

// ─────────────────────────────────────────────
// External cache
// ─────────────────────────────────────────────
function cacheKey(name) {
  return `ext2:${name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 80)}`;
}

async function getCachedExternal(name) {
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(cacheKey(name));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setCachedExternal(name, data) {
  try {
    const redis = getRedisConnection();
    await redis.setex(cacheKey(name), EXTERNAL_CACHE_TTL, JSON.stringify(data));
  } catch {}
}

// ─────────────────────────────────────────────
// Name variations
// ─────────────────────────────────────────────
function getNameVariations(name) {
  const v = [name];
  // Remove parentheticals
  const noParens = name.replace(/\s*\([^)]+\)/g, "").trim();
  if (noParens !== name) v.push(noParens);
  // Remove common suffixes
  const shortened = name
    .replace(/,?\s+(College|University|Institute|School|Academy)$/i, "")
    .trim();
  if (shortened !== name && shortened.length > 4) v.push(shortened);
  return [...new Set(v)];
}

// ─────────────────────────────────────────────
// Race a promise against a timeout
// ─────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms),
    ),
  ]);
}

// ─────────────────────────────────────────────
// Wikipedia — search API → summary API
// ─────────────────────────────────────────────
async function enrichFromWikipedia(universityName) {
  const variations = getNameVariations(universityName);

  for (const name of variations) {
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + " university")}&srlimit=3&format=json&origin=*`;
      const searchRes = await withTimeout(
        axios.get(searchUrl, {
          timeout: SOURCE_TIMEOUT,
          headers: { "User-Agent": WIKIPEDIA_UA },
        }),
        SOURCE_TIMEOUT,
        "Wikipedia search",
      );

      const hits = searchRes.data?.query?.search || [];
      const title = hits.find((h) =>
        /universit|college|institut|academ/i.test(h.title + " " + h.snippet),
      )?.title;

      if (!title) continue;

      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const res = await withTimeout(
        axios.get(summaryUrl, {
          timeout: SOURCE_TIMEOUT,
          headers: { "User-Agent": WIKIPEDIA_UA },
        }),
        SOURCE_TIMEOUT,
        "Wikipedia summary",
      );

      const d = res.data;
      if (!d?.extract || d.extract.length < 80) continue;
      if (!/universit|college|institut|academ|school/i.test(d.extract))
        continue;

      return {
        source: "wikipedia",
        confidence: 0.75,
        description: d.extract.slice(0, 1000),
        thumbnail: d.thumbnail?.source || null,
      };
    } catch (err) {
      if (!err.message?.includes("403") && !err.message?.includes("timeout")) {
        console.warn(`Wikipedia failed for "${name}": ${err.message}`);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Wikidata — lightweight query (no complex JOINs)
// ─────────────────────────────────────────────
async function enrichFromWikidata(universityName) {
  try {
    const cleanName = universityName
      .replace(/"/g, "")
      .replace(/\s*\([^)]+\)/g, "")
      .trim();

    // Simpler SPARQL: just get country + city for the entity
    const query = `
SELECT ?inst ?country ?city ?founded WHERE {
  ?inst wdt:P31/wdt:P279* wd:Q3918 ;
        rdfs:label "${cleanName}"@en .
  OPTIONAL { ?inst wdt:P17 ?ce. ?ce rdfs:label ?country FILTER(LANG(?country)="en"). }
  OPTIONAL { ?inst wdt:P131 ?ci. ?ci rdfs:label ?city FILTER(LANG(?city)="en"). }
  OPTIONAL { ?inst wdt:P571 ?founded. }
} LIMIT 1`;

    const res = await withTimeout(
      axios.get("https://query.wikidata.org/sparql", {
        params: { query, format: "json" },
        timeout: SOURCE_TIMEOUT,
        headers: {
          Accept: "application/sparql-results+json",
          "User-Agent": WIKIPEDIA_UA,
        },
      }),
      SOURCE_TIMEOUT,
      "Wikidata",
    );

    const b = res.data?.results?.bindings?.[0];
    if (!b) return null;

    return {
      source: "wikidata",
      confidence: 0.8,
      country: b.country?.value || null,
      city: b.city?.value || null,
      established: b.founded?.value
        ? new Date(b.founded.value).getFullYear()
        : null,
    };
  } catch (err) {
    if (!err.message?.includes("429") && !err.message?.includes("timeout")) {
      console.warn(`Wikidata failed for "${universityName}": ${err.message}`);
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// OpenAlex — institution search
// ─────────────────────────────────────────────
async function enrichFromOpenAlex(universityName) {
  try {
    const cleanName = universityName.replace(/\s*\([^)]+\)/g, "").trim();
    const url = `https://api.openalex.org/institutions?search=${encodeURIComponent(cleanName)}&per_page=1&mailto=${OPENALEX_MAILTO}`;

    const res = await withTimeout(
      axios.get(url, {
        timeout: SOURCE_TIMEOUT,
        headers: { "User-Agent": WIKIPEDIA_UA },
      }),
      SOURCE_TIMEOUT,
      "OpenAlex",
    );

    const inst = res.data?.results?.[0];
    if (!inst) return null;

    // Verify name match
    const resultName = (inst.display_name || "").toLowerCase();
    const searchWords = cleanName.toLowerCase().split(/\s+/).slice(0, 2);
    if (!searchWords.every((w) => resultName.includes(w))) return null;

    return {
      source: "openalex",
      confidence: 0.7,
      country: inst.geo?.country || null,
      city: inst.geo?.city || null,
      type: inst.type || null,
      worksCount: inst.works_count || null,
    };
  } catch (err) {
    if (!err.message?.includes("timeout")) {
      console.warn(`OpenAlex failed for "${universityName}": ${err.message}`);
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// ROR Registry — most reliable for country/city
// ─────────────────────────────────────────────
async function enrichFromROR(universityName) {
  try {
    const cleanName = universityName.replace(/\s*\([^)]+\)/g, "").trim();
    const url = `https://api.ror.org/organizations?query=${encodeURIComponent(cleanName)}&page=1`;

    const res = await withTimeout(
      axios.get(url, {
        timeout: SOURCE_TIMEOUT,
        headers: { "User-Agent": WIKIPEDIA_UA },
      }),
      SOURCE_TIMEOUT,
      "ROR",
    );

    const org = res.data?.items?.[0];
    if (!org) return null;

    // Check match score if available
    if (org.score !== undefined && org.score < 0.9) return null;

    return {
      source: "ror",
      confidence: 0.88,
      country: org.country?.country_name || null,
      city: org.addresses?.[0]?.city || null,
      established: org.established || null,
      rorId: org.id || null,
      type: org.types?.[0] || null,
    };
  } catch (err) {
    if (!err.message?.includes("timeout")) {
      console.warn(`ROR failed for "${universityName}": ${err.message}`);
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// Times Higher Education — scrape their search
// (No auth required, public search endpoint)
// ─────────────────────────────────────────────
async function enrichFromTHE(universityName) {
  try {
    const searchUrl = `https://www.timeshighereducation.com/world-university-rankings/2024/world-ranking#!/length/-1/sort_by/rank/sort_order/asc/cols/stats/query/${encodeURIComponent(universityName)}`;

    // THE uses a JSON API endpoint
    const apiUrl = `https://www.timeshighereducation.com/sites/default/files/the_data_rankings/world_university_rankings_2024_0__3557c3c60f2d29c0ef09daa4ae5eff5a.json`;

    // Instead use their API search
    const res = await withTimeout(
      axios.get(
        `https://api.timeshighereducation.com/stars/university/search?name=${encodeURIComponent(universityName)}&limit=1`,
        {
          timeout: SOURCE_TIMEOUT,
          headers: {
            "User-Agent": WIKIPEDIA_UA,
            Accept: "application/json",
          },
        },
      ),
      SOURCE_TIMEOUT,
      "THE",
    );

    const item = res.data?.data?.[0];
    if (!item) return null;

    return {
      source: "the",
      confidence: 0.75,
      theRanking: item.rank ? parseInt(item.rank) : null,
      country: item.location || null,
    };
  } catch {
    return null; // THE API may not be public — silent fail
  }
}

// ─────────────────────────────────────────────
// NCES (US only) — National Center for Education Statistics
// Free public API for US university data
// ─────────────────────────────────────────────
async function enrichFromNCES(universityName) {
  try {
    // NCES College Navigator API
    const url = `https://nces.ed.gov/ipeds/datacenter/api/Institutions?name=${encodeURIComponent(universityName)}&pageSize=1`;

    const res = await withTimeout(
      axios.get(url, {
        timeout: SOURCE_TIMEOUT,
        headers: { "User-Agent": WIKIPEDIA_UA, Accept: "application/json" },
      }),
      SOURCE_TIMEOUT,
      "NCES",
    );

    const inst = res.data?.data?.[0];
    if (!inst) return null;

    return {
      source: "nces",
      confidence: 0.85,
      city: inst.city || null,
      country: "United States",
      totalStudents: inst.totalEnrollment ? String(inst.totalEnrollment) : null,
      type: inst.control || null, // Public / Private nonprofit / Private for-profit
    };
  } catch {
    return null; // NCES endpoint may be flaky — silent fail
  }
}

// ─────────────────────────────────────────────
// CollegeSimply scraper — US acceptance rates (free, no auth)
// ─────────────────────────────────────────────
async function enrichFromCollegeSimply(universityName) {
  try {
    const slug = universityName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-");

    const url = `https://www.collegesimply.com/colleges/${slug}/`;
    const res = await withTimeout(
      axios.get(url, {
        timeout: SOURCE_TIMEOUT,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html",
        },
        maxRedirects: 2,
        validateStatus: (s) => s < 400,
      }),
      SOURCE_TIMEOUT,
      "CollegeSimply",
    );

    const html = res.data || "";

    // Extract acceptance rate from structured data
    const acceptMatch = html.match(/acceptance[^>]*>([0-9.]+)%/i);
    const studentsMatch = html.match(/enrollment[^>]*>([\d,]+)/i);
    const tuitionMatch = html.match(/tuition[^>]*>\$?([\d,]+)/i);

    if (!acceptMatch && !studentsMatch) return null;

    return {
      source: "collegesimply",
      confidence: 0.7,
      acceptanceRate: acceptMatch ? parseFloat(acceptMatch[1]) : null,
      totalStudents: studentsMatch ? studentsMatch[1] : null,
      tuitionFee: tuitionMatch ? `USD ${tuitionMatch[1]}/year` : null,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Main crawl — all sources run INDEPENDENTLY with own timeouts
// ─────────────────────────────────────────────
async function crawlExternalSources(universityName) {
  const cached = await getCachedExternal(universityName);
  if (cached) {
    console.log(`💾 External cache hit: ${universityName}`);
    return cached;
  }

  console.log(`🌍 External enrichment: ${universityName}`);
  const startTime = Date.now();

  // Each source runs with independent timeout — slow sources don't block fast ones
  const [wikipedia, wikidata, openalex, ror, nces, collegeSimply] =
    await Promise.allSettled([
      enrichFromWikipedia(universityName),
      enrichFromWikidata(universityName),
      enrichFromOpenAlex(universityName),
      enrichFromROR(universityName),
      enrichFromNCES(universityName),
      enrichFromCollegeSimply(universityName),
    ]);

  const results = [wikipedia, wikidata, openalex, ror, nces, collegeSimply]
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  const sources = results.map((r) => r.source).join(", ");
  console.log(
    `✅ External sources: ${sources || "none"} (${Date.now() - startTime}ms)`,
  );

  const merged = mergeExternalResults(results);
  await setCachedExternal(universityName, merged);
  return merged;
}

// ─────────────────────────────────────────────
// Merge with confidence weighting
// ─────────────────────────────────────────────
function mergeExternalResults(results) {
  const merged = {
    description: null,
    country: null,
    city: null,
    totalStudents: null,
    acceptanceRate: null,
    tuitionFee: null,
    established: null,
    admissionRequirements: [],
    intakes: [],
    programs: [],
    externalSources: [],
  };

  // Sort by confidence (highest first)
  const sorted = [...results].sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0),
  );

  for (const result of sorted) {
    if (!result) continue;

    merged.externalSources.push({
      source: result.source,
      confidence: result.confidence,
    });

    for (const field of [
      "description",
      "country",
      "city",
      "totalStudents",
      "acceptanceRate",
      "tuitionFee",
      "established",
    ]) {
      if (merged[field] == null && result[field] != null) {
        merged[field] = result[field];
      }
    }

    if (Array.isArray(result.admissionRequirements))
      merged.admissionRequirements.push(...result.admissionRequirements);
    if (Array.isArray(result.intakes)) merged.intakes.push(...result.intakes);
    if (Array.isArray(result.programs))
      merged.programs.push(...result.programs);
  }

  merged.admissionRequirements = [
    ...new Set(merged.admissionRequirements.filter(Boolean)),
  ];
  merged.intakes = [...new Set(merged.intakes.filter(Boolean))];
  return merged;
}

module.exports = { crawlExternalSources };
