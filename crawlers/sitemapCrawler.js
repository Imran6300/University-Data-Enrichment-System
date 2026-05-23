/**
 * FIXED: sitemapCrawler.js
 *
 * Key fixes:
 * - Hard cap of 20 URLs returned (was returning 3000+ noisy URLs)
 * - Score-based filtering before returning (not after)
 * - Skips sitemap if domain is blocked/dead
 * - Handles sitemap index files (multiple nested sitemaps)
 * - Deduplicates by normalized path
 * - Respects known-failed URL cache
 */

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const { isUrlPermanentlyFailed } = require("../utils/crawlCache");
const { canCrawlUrl } = require("../utils/domainHealth");

const SITEMAP_TIMEOUT = 10000;
const MAX_SITEMAP_URLS = 20; // hard cap on what we return
const SITEMAP_FETCH_LIMIT = 500; // max URLs to parse from sitemap (avoid 50K URL sitemaps)

// Mirrors the score rules from pageDiscovery
function scoreUrl(url) {
  const path = url.toLowerCase();

  if (/\/admiss/i.test(path)) return 100;
  if (/\/apply|\/application/i.test(path)) return 95;
  if (/\/tuition|\/fee|\/financ|\/cost/i.test(path)) return 90;
  if (/\/program|\/programme/i.test(path)) return 85;
  if (/\/course|\/curriculum/i.test(path)) return 80;
  if (/\/academic/i.test(path)) return 75;
  if (/\/undergraduate|\/ug\b/i.test(path)) return 75;
  if (/\/postgraduate|\/graduate|\/master/i.test(path)) return 70;
  if (/\/phd|\/doctoral/i.test(path)) return 70;
  if (/\/international/i.test(path)) return 65;
  if (/\/scholarship/i.test(path)) return 60;
  if (/\/about|\/overview/i.test(path)) return 40;

  // Negative patterns — exclude
  if (/\/news|\/event|\/blog|\/article|\/press/i.test(path)) return -999;
  if (/\/staff|\/directory|\/trustee/i.test(path)) return -999;
  if (/\/login|\/register|\/cart/i.test(path)) return -999;
  if (/\.(pdf|doc|zip)$/i.test(path)) return -999;
  if (/\/tag\/|\/category\//i.test(path)) return -999;
  if (/\?p=\d+|\?page_id=\d+/i.test(path)) return -999;

  return 5; // neutral
}

function normalizePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// ─────────────────────────────────────────────
// Fetch and parse a single sitemap URL
// Returns array of page URLs (not sitemap index URLs)
// ─────────────────────────────────────────────
async function fetchSitemap(sitemapUrl, depth = 0) {
  if (depth > 2) return []; // prevent infinite recursion

  try {
    const res = await axios.get(sitemapUrl, {
      timeout: SITEMAP_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UniversityBot/1.0)",
        Accept: "application/xml,text/xml,*/*",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: (s) => s < 400,
      maxRedirects: 3,
    });

    const xml = typeof res.data === "string" ? res.data : res.data.toString();
    const $ = cheerio.load(xml, { xmlMode: true });

    // Is this a sitemap index? (contains <sitemap> tags)
    const sitemapRefs = $("sitemap loc");
    if (sitemapRefs.length > 0 && depth === 0) {
      // Fetch up to 3 sub-sitemaps (prioritize those with admissions/programs in URL)
      const subSitemaps = [];
      sitemapRefs.each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) subSitemaps.push(loc);
      });

      // Prioritize relevant sub-sitemaps
      const prioritized = subSitemaps
        .sort((a, b) => {
          const aScore = /admiss|program|course|academic/i.test(a) ? 1 : 0;
          const bScore = /admiss|program|course|academic/i.test(b) ? 1 : 0;
          return bScore - aScore;
        })
        .slice(0, 3);

      const results = [];
      for (const sub of prioritized) {
        const urls = await fetchSitemap(sub, depth + 1);
        results.push(...urls);
        if (results.length >= SITEMAP_FETCH_LIMIT) break;
      }
      return results;
    }

    // Regular sitemap — extract <url><loc> entries
    const urls = [];
    $("url loc").each((_, el) => {
      if (urls.length >= SITEMAP_FETCH_LIMIT) return false;
      const loc = $(el).text().trim();
      if (loc) urls.push(loc);
    });

    return urls;
  } catch (err) {
    // Silently ignore — sitemaps are optional
    return [];
  }
}

// ─────────────────────────────────────────────
// Main sitemap crawler
// ─────────────────────────────────────────────
async function crawlSitemap(website) {
  const base = website.replace(/\/$/, "");

  // Check domain health
  const { canCrawl } = await canCrawlUrl(base);
  if (!canCrawl) {
    return [];
  }

  // Try common sitemap locations
  const sitemapCandidates = [
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
    `${base}/sitemap-index.xml`,
    `${base}/sitemap/`,
  ];

  let allUrls = [];

  for (const candidate of sitemapCandidates) {
    const urls = await fetchSitemap(candidate);
    if (urls.length > 0) {
      allUrls = urls;
      console.log(`🗺️ Sitemap: found ${urls.length} URLs from ${candidate}`);
      break;
    }
  }

  if (allUrls.length === 0) {
    // Sitemap not found or empty
    return [];
  }

  // Score, deduplicate, and cap
  const seen = new Set();
  const scored = [];

  for (const url of allUrls) {
    const score = scoreUrl(url);
    if (score < 0) continue; // exclude

    const norm = normalizePath(url);
    if (seen.has(norm)) continue;
    seen.add(norm);

    scored.push({ url, score });
  }

  // Sort by score, take top MAX_SITEMAP_URLS
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SITEMAP_URLS);

  // Filter known-failed URLs
  const filtered = [];
  for (const { url } of top) {
    const failed = await isUrlPermanentlyFailed(url);
    if (!failed) filtered.push(url);
  }

  console.log(
    `🗺️ Sitemap: kept ${filtered.length} priority pages (from ${allUrls.length} total)`,
  );
  return filtered;
}

module.exports = { crawlSitemap };
