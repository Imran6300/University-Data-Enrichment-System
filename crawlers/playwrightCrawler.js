/**
 * FIXED: playwrightCrawler.js
 *
 * CRITICAL FIXES:
 * - Browser recycled every 50 pages (was leaking memory → OOM at 4GB)
 * - Hard memory ceiling: if process.memoryUsage().rss > 2.5GB → force GC + browser restart
 * - Max 2 concurrent Playwright pages (enforced with a proper semaphore)
 * - Context closed in finally block ALWAYS (was leaking contexts on error)
 * - 12s page timeout (was 15s — faster fail = less RAM held)
 * - No networkidle wait (was holding RAM for 3s+ per page)
 */

const { chromium } = require("playwright");
const { cleanHtml } = require("../services/htmlCleaner");
const { recordCrawlResult } = require("../utils/domainHealth");
const { cachePageContent } = require("../utils/crawlCache");

const CRAWL_DELAY_MIN = parseInt(process.env.CRAWL_DELAY_MIN) || 600;
const CRAWL_DELAY_MAX = parseInt(process.env.CRAWL_DELAY_MAX) || 1800;
const MAX_CONCURRENT_PW = parseInt(process.env.MAX_PLAYWRIGHT_CONCURRENT) || 2;
const BROWSER_RECYCLE_AFTER = parseInt(process.env.BROWSER_RECYCLE_AFTER) || 50;
const PAGE_TIMEOUT_MS = 12000;
const MEMORY_CEILING_MB = parseInt(process.env.PW_MEMORY_CEILING_MB) || 2500;

// ─────────────────────────────────────────────
// Semaphore — true slot-based concurrency control
// ─────────────────────────────────────────────
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    if (this.queue.length > 0 && this.current < this.max) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT_PW);

// ─────────────────────────────────────────────
// Browser pool with page counter + memory watch
// ─────────────────────────────────────────────
let browserInstance = null;
let browserLaunchPromise = null;
let pageCount = 0;
let browserLock = false;

const BLOCKED_RESOURCE_TYPES = new Set([
  "media",
  "font",
  "stylesheet",
  "image",
  "manifest",
  "other",
]);

const BLOCKED_DOMAINS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.com",
  "twitter.com",
  "hotjar.com",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "intercom.io",
  "zendesk.com",
  "hubspot.com",
  "optimizely.com",
];

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--window-size=1280,800",
      "--js-flags=--max-old-space-size=384", // limit per-browser V8 heap
      "--disable-background-networking",
      "--disable-default-apps",
      "--mute-audio",
    ],
  });
}

async function getBrowser() {
  // Check memory ceiling
  const rssGB = process.memoryUsage().rss / 1024 / 1024;
  if (rssGB > MEMORY_CEILING_MB) {
    console.warn(
      `⚠️ Memory ceiling hit (${Math.round(rssGB)}MB) — recycling browser`,
    );
    await recycleBrowser();
    return getBrowser();
  }

  // Recycle after N pages
  if (pageCount >= BROWSER_RECYCLE_AFTER && !browserLock) {
    await recycleBrowser();
  }

  if (browserInstance?.isConnected()) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = launchBrowser().then((b) => {
    browserInstance = b;
    browserLaunchPromise = null;
    pageCount = 0;
    b.on("disconnected", () => {
      browserInstance = null;
      browserLaunchPromise = null;
      console.warn("⚠️ Playwright browser disconnected");
    });
    return b;
  });

  return browserLaunchPromise;
}

async function recycleBrowser() {
  if (browserLock) return;
  browserLock = true;
  try {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
    pageCount = 0;
    // Give GC a moment
    await new Promise((r) => setTimeout(r, 500));
    if (global.gc) global.gc();
  } finally {
    browserLock = false;
  }
}

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: {} };
`;

// ─────────────────────────────────────────────
// Main Playwright crawl
// ─────────────────────────────────────────────
async function playwrightCrawl(url, options = {}) {
  await semaphore.acquire();

  const delay =
    CRAWL_DELAY_MIN + Math.random() * (CRAWL_DELAY_MAX - CRAWL_DELAY_MIN);
  await new Promise((r) => setTimeout(r, delay));

  let context = null;
  let page = null;

  try {
    const browser = await getBrowser();
    pageCount++;

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9", DNT: "1" },
      locale: "en-US",
      // Disable JS features that leak memory
      javaScriptEnabled: true,
    });

    await context.addInitScript(STEALTH_SCRIPT);
    page = await context.newPage();

    // Aggressive resource blocking
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      const reqUrl = route.request().url();
      if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort();
      if (BLOCKED_DOMAINS.some((d) => reqUrl.includes(d))) return route.abort();
      route.continue();
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Short fixed wait instead of networkidle (saves 2-3s RAM hold per page)
    await new Promise((r) => setTimeout(r, 1000));

    const html = await page.content().catch(() => null);
    if (!html) return null;

    // Extract images with tight limit
    let imgUrls = [];
    try {
      imgUrls = await page.evaluate(() => {
        const urls = new Set();
        document.querySelectorAll("img[src], img[data-src]").forEach((el) => {
          const src = el.src || el.getAttribute("data-src");
          if (src && !src.startsWith("data:") && src.startsWith("http")) {
            urls.add(src);
          }
        });
        return [...urls].slice(0, 60);
      });
    } catch (_) {}

    const cleanedText = cleanHtml(html, url) || "";
    await recordCrawlResult(url, { statusCode: response?.status() || 200 });

    const result = {
      url,
      cleanedText,
      images: imgUrls,
      statusCode: response?.status() || 200,
    };

    if (cleanedText.length > 200) {
      await cachePageContent(url, result);
    }

    return result;
  } catch (err) {
    await recordCrawlResult(url, { error: err });
    console.error(`❌ Playwright failed: ${url} — ${err.message}`);
    return null;
  } finally {
    semaphore.release();
    // Always close context to free memory
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function shouldUsePlawright(url, cheerioResult) {
  if (!cheerioResult) return true;
  if (cheerioResult.cleanedText?.length === 0) return true;
  if (cheerioResult.cleanedText?.length < 400) return true;
  return false;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

module.exports = { playwrightCrawl, shouldUsePlawright, closeBrowser };
