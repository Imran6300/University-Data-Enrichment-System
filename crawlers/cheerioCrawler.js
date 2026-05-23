/**
 * FIXED: cheerioCrawler.js
 *
 * Key fixes:
 * - Checks domain health before attempting crawl (skip blocked domains)
 * - Checks URL failure cache (skip known 404s immediately)
 * - Records crawl results in domain health tracker
 * - Caches successful page content (avoid re-crawling unchanged pages)
 * - NO retries on 404 (was doing 3 retries on every 404 fallback URL)
 * - NO retries on ENOTFOUND (domain is dead, bail immediately)
 * - Smarter 403 handling: record in domain health, don't retry blindly
 */

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const { cleanHtml } = require("../services/htmlCleaner");
const {
  isUrlPermanentlyFailed,
  markUrlFailed,
  getCachedPage,
  cachePageContent,
} = require("../utils/crawlCache");
const { canCrawlUrl, recordCrawlResult } = require("../utils/domainHealth");

const CRAWL_DELAY_MIN = parseInt(process.env.CRAWL_DELAY_MIN) || 1000;
const CRAWL_DELAY_MAX = parseInt(process.env.CRAWL_DELAY_MAX) || 3000;

// ─────────────────────────────────────────────
// Stealth browser profiles
// ─────────────────────────────────────────────
const BROWSER_PROFILES = [
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "sec-ch-ua":
      '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "sec-ch-ua":
      '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-mobile": "?0",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  },
];

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: 10,
  timeout: 30000,
});

const domainLastHit = new Map();

async function domainRateLimit(url) {
  try {
    const domain = new URL(url).hostname;
    const last = domainLastHit.get(domain) || 0;
    const elapsed = Date.now() - last;
    const minGap =
      CRAWL_DELAY_MIN + Math.random() * (CRAWL_DELAY_MAX - CRAWL_DELAY_MIN);
    if (elapsed < minGap) {
      await sleep(minGap - elapsed);
    }
    domainLastHit.set(domain, Date.now());
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomProfile() {
  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

function buildHeaders() {
  const profile = randomProfile();
  return {
    ...profile,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    DNT: "1",
    Referer: "https://www.google.com/",
  };
}

// ─────────────────────────────────────────────
// Main crawl function
// ─────────────────────────────────────────────
async function cheerioCrawl(url, options = {}) {
  // 1. Check permanent failure cache
  const permanentlyFailed = await isUrlPermanentlyFailed(url);
  if (permanentlyFailed) {
    return null; // skip silently
  }

  // 2. Check domain health
  const { canCrawl, reason, status } = await canCrawlUrl(url);
  if (!canCrawl) {
    return null; // skip silently — domain is blocked/dead
  }

  // 3. Check page cache
  if (!options.skipCache) {
    const cached = await getCachedPage(url);
    if (cached) {
      return {
        ...cached,
        fromCache: true,
      };
    }
  }

  await domainRateLimit(url);

  const headers = buildHeaders();

  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (s) => s < 600,
      httpsAgent,
      decompress: true,
    });

    const statusCode = response.status;

    // Handle specific status codes — NO retries for permanent failures
    if (statusCode === 404) {
      await markUrlFailed(url, "404 Not Found", 404);
      await recordCrawlResult(url, { statusCode });
      return null;
    }

    if (statusCode === 410) {
      // 410 Gone = permanently removed
      await markUrlFailed(url, "410 Gone", 410);
      return null;
    }

    if (statusCode === 403) {
      await recordCrawlResult(url, {
        statusCode,
        error: new Error("403 Forbidden"),
      });
      throw new Error(`403 Forbidden: ${url}`);
    }

    if (statusCode === 429) {
      const retryAfter = parseInt(response.headers["retry-after"] || "60");
      throw new Error(`429 Rate limited — retry after ${retryAfter}s`);
    }

    if (statusCode >= 500) {
      throw new Error(`${statusCode} Server error: ${url}`);
    }

    // Validate content type
    const contentType = response.headers["content-type"] || "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return null; // not HTML — skip silently
    }

    const html =
      typeof response.data === "string"
        ? response.data
        : response.data.toString("utf-8");

    const $ = cheerio.load(html);

    // Extract images
    const imageSet = new Set();
    $("img[src], img[data-src], img[data-lazy-src], source[srcset]").each(
      (_, el) => {
        const sources = [
          $(el).attr("src"),
          $(el).attr("data-src"),
          $(el).attr("data-lazy-src"),
          $(el).attr("data-original"),
        ].filter(Boolean);

        for (const src of sources) {
          if (src.startsWith("data:")) continue;
          try {
            imageSet.add(new URL(src, url).href);
          } catch (_) {}
        }
      },
    );

    const cleanedText = cleanHtml(html, url) || "";

    const result = {
      url,
      cleanedText,
      images: [...imageSet],
      statusCode,
    };

    // Record success in domain health
    await recordCrawlResult(url, { statusCode });

    // Cache the result
    if (cleanedText.length > 100) {
      await cachePageContent(url, result);
    }

    return result;
  } catch (err) {
    await recordCrawlResult(url, { error: err });

    // Re-throw for caller to handle
    throw err;
  }
}

module.exports = { cheerioCrawl };
