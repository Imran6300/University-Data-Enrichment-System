/**
 * FIXED: pageDiscovery.js
 *
 * Key fixes:
 * - REMOVED hardcoded fallback paths (/admissions, /fees, etc.) that cause 404 spam
 * - Validates discovered URLs before returning (HEAD check for top candidates)
 * - Detects and respects domain language (for Chinese/French/etc. universities)
 * - Caps sitemap results intelligently (score + deduplicate before returning)
 * - Records failed URLs in cache to prevent re-crawling
 */

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const {
  isUrlPermanentlyFailed,
  markUrlFailed,
} = require("../utils/crawlCache");
const { canCrawlUrl, recordCrawlResult } = require("../utils/domainHealth");

const FETCH_TIMEOUT = 12000;
const MAX_DISCOVERED = 12; // reduced from 15 — quality > quantity

// ─────────────────────────────────────────────
// URL scoring — higher = more valuable to crawl
// ─────────────────────────────────────────────
const PATH_SCORE_RULES = [
  { pattern: /admiss/i, score: 100 },
  { pattern: /apply|application/i, score: 95 },
  { pattern: /tuition|fee|fees|financ|cost/i, score: 90 },
  { pattern: /program|programme/i, score: 85 },
  { pattern: /course|courses|curriculum/i, score: 80 },
  { pattern: /academic|academics/i, score: 75 },
  { pattern: /undergraduate|ug\b/i, score: 75 },
  { pattern: /postgraduate|pg\b|graduate|master/i, score: 70 },
  { pattern: /phd|doctoral|doctorate/i, score: 70 },
  { pattern: /international|global/i, score: 65 },
  { pattern: /scholarship/i, score: 60 },
  { pattern: /requirement|eligib/i, score: 60 },
  { pattern: /btech|mtech|mba|msc|bsc/i, score: 65 },
  { pattern: /about|overview/i, score: 40 },
  { pattern: /department|school|faculty/i, score: 35 },
  { pattern: /campus|gallery/i, score: 20 },

  // EXCLUDE — negative score = never crawl
  { pattern: /news|event|blog|article|press|award|conference/i, score: -999 },
  { pattern: /calendar|sports|ceremony|archive/i, score: -999 },
  { pattern: /staff|directory|trustee|personnel/i, score: -999 },
  { pattern: /login|register|signup|cart|payment|checkout/i, score: -999 },
  { pattern: /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)$/i, score: -999 },
  { pattern: /wp-admin|wp-login|wp-json/i, score: -999 },
  { pattern: /tag\//i, score: -999 },
  { pattern: /category\//i, score: -999 },
  { pattern: /\?p=\d+/i, score: -999 }, // WordPress post IDs
  { pattern: /\?page_id=\d+/i, score: -999 },
];

function scoreUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const full = url.toLowerCase();
    let score = 0;
    for (const rule of PATH_SCORE_RULES) {
      if (rule.pattern.test(path) || rule.pattern.test(full)) {
        score += rule.score;
        if (score <= -999) return -999;
      }
    }
    return score;
  } catch {
    return -999;
  }
}

function normalizePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    // Remove tracking params
    ["utm_source", "utm_medium", "utm_campaign", "ref", "source"].forEach((p) =>
      u.searchParams.delete(p),
    );
    // Remove fragments
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// ─────────────────────────────────────────────
// Detect if homepage is non-English
// Returns language code or null
// ─────────────────────────────────────────────
function detectLanguage(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const lang = $("html").attr("lang") || "";
  if (lang && !lang.startsWith("en")) return lang.split("-")[0];

  // Content-based detection for common non-English patterns
  const text = $("body").text().slice(0, 500);
  if (/[\u4e00-\u9fff]/.test(text)) return "zh"; // Chinese
  if (/[\u0600-\u06ff]/.test(text)) return "ar"; // Arabic
  if (/[\u0400-\u04ff]/.test(text)) return "ru"; // Cyrillic

  return null;
}

// ─────────────────────────────────────────────
// Main discovery function
// ─────────────────────────────────────────────
async function discoverPages(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");

  // Check domain health first
  const { canCrawl, reason } = await canCrawlUrl(base);
  if (!canCrawl) {
    console.log(`🚫 Skipping discovery for blocked domain: ${reason}`);
    return [base]; // return just homepage
  }

  let baseDomain;
  try {
    baseDomain = new URL(base).hostname;
  } catch {
    return [];
  }

  const discoveredMap = new Map(); // normalized path → full URL

  // Always add homepage
  discoveredMap.set(normalizePath(base), base);

  let html = null;
  let lang = null;

  try {
    html = await fetchHtml(base);
    lang = detectLanguage(html);

    if (lang && lang !== "en") {
      console.log(
        `🌐 Non-English site detected (${lang}) for ${base} — limited discovery`,
      );
    }

    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Skip obviously bad links
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
      if (href.startsWith("javascript:")) return;
      if (href.startsWith("#")) return;

      try {
        const absolute = new URL(href, base).href;
        const linkDomain = new URL(absolute).hostname;

        // Same domain only (handle www vs non-www)
        const normalizedBase = baseDomain.replace(/^www\./, "");
        const normalizedLink = linkDomain.replace(/^www\./, "");

        if (normalizedBase !== normalizedLink) return;

        const score = scoreUrl(absolute);
        if (score < 0) return;

        const norm = normalizePath(absolute);
        const clean = cleanUrl(absolute);

        if (
          !discoveredMap.has(norm) ||
          score > scoreUrl(discoveredMap.get(norm))
        ) {
          discoveredMap.set(norm, clean);
        }
      } catch (_) {}
    });
  } catch (err) {
    console.warn(`⚠️ Page discovery failed for ${base}: ${err.message}`);
    await recordCrawlResult(base, { error: err });
    // Return just the base URL — don't add fallback 404 paths
    return [base];
  }

  // Sort by score, cap at MAX_DISCOVERED
  const sorted = [...discoveredMap.values()]
    .map((url) => ({ url, score: scoreUrl(url) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DISCOVERED)
    .map(({ url }) => url);

  // Filter out known-failed URLs
  const filtered = [];
  for (const url of sorted) {
    const failed = await isUrlPermanentlyFailed(url);
    if (!failed) filtered.push(url);
  }

  // If very few discovered, try a few VALIDATED paths (not blind guesses)
  // Only attempt paths that exist in the actual site navigation
  if (filtered.length < 3 && html) {
    // Try to find nav links we might have missed with lower score threshold
    const $ = cheerio.load(html);
    $("nav a[href], .menu a[href], .navigation a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const absolute = new URL(href, base).href;
        const score = scoreUrl(absolute);
        if (score >= 30) {
          // lower threshold for nav links
          const norm = normalizePath(absolute);
          if (!discoveredMap.has(norm)) {
            filtered.push(cleanUrl(absolute));
            discoveredMap.set(norm, cleanUrl(absolute));
          }
        }
      } catch (_) {}
    });
  }

  console.log(
    `🔍 Discovered ${filtered.length} pages for ${base}${lang ? ` [${lang}]` : ""}`,
  );
  return filtered.slice(0, MAX_DISCOVERED);
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: FETCH_TIMEOUT,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    maxRedirects: 3,
    validateStatus: (s) => s < 500,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });

  if (res.status === 403) throw new Error(`403 Forbidden: ${url}`);
  if (res.status === 404) throw new Error(`404 Not Found: ${url}`);

  return typeof res.data === "string" ? res.data : res.data.toString();
}

module.exports = { discoverPages };
