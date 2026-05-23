/**
 * UPGRADED: htmlCleaner.js
 *
 * Key improvements:
 * - More aggressive noise removal (cookie banners, chat widgets, popups)
 * - Falls back to manual body text extraction if Readability fails
 * - Removes repeated whitespace more aggressively
 * - Truncates to configurable max length
 * - Strips common boilerplate patterns (nav links, footer text)
 */

const { Readability } = require("@mozilla/readability");
const { JSDOM, VirtualConsole } = require("jsdom");

const MAX_CONTENT_CHARS = parseInt(process.env.MAX_HTML_CHARS) || 20000;

// All noise elements to remove before Readability
const NOISE_SELECTORS = [
  // Navigation & chrome
  "nav",
  "header",
  "footer",
  "aside",
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",

  // Cookie/GDPR
  ".cookie-banner",
  ".cookie-notice",
  ".cookie-bar",
  ".cookie-consent",
  "#cookie-notice",
  "#cookie-banner",
  "#cookie-bar",
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="gdpr"]',
  '[id*="gdpr"]',
  '[class*="consent"]',
  '[id*="consent"]',

  // Ads & tracking
  ".ads",
  ".advertisement",
  ".ad-wrapper",
  ".ad-container",
  '[class*="advertisement"]',
  '[id*="advertisement"]',

  // Popups & modals
  '[class*="popup"]',
  '[class*="modal"]',
  '[class*="overlay"]',
  '[class*="dialog"]',
  '[id*="popup"]',
  '[id*="modal"]',

  // Chat widgets
  '[class*="chatbot"]',
  '[class*="chat-widget"]',
  '[id*="chat"]',
  ".intercom-container",
  "#intercom-container",
  ".crisp-client",
  "#crisp-chatbox",

  // Layout noise
  ".sidebar",
  "#sidebar",
  ".side-bar",
  ".social-share",
  ".social-links",
  ".breadcrumb",
  ".breadcrumbs",
  ".pagination",
  ".newsletter",
  ".subscribe",

  // Common CMS noise
  ".wp-block-shortcode",
  ".elementor-location-header",
  ".elementor-location-footer",
];

// Patterns in text that indicate boilerplate — strip lines containing these
const BOILERPLATE_PATTERNS = [
  /^(home|menu|skip to|back to top|share|follow us|copyright|all rights reserved|privacy policy|terms of use|sitemap)/i,
  /^\s*[|•·–—]\s*$/, // separator lines
  /^(facebook|twitter|linkedin|instagram|youtube|social media)/i,
];

function isBoilerplateLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 3) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(trimmed));
}

function cleanHtml(html, url = "https://example.com") {
  try {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", () => {});
    virtualConsole.on("warn", () => {});

    const dom = new JSDOM(html, {
      url,
      pretendToBeVisual: false,
      resources: "usable",
      runScripts: "outside-only",
      virtualConsole,
    });

    const document = dom.window.document;

    // Remove noise elements
    for (const selector of NOISE_SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach((el) => el.remove());
      } catch (_) {}
    }

    // Try Readability first
    let text = "";
    try {
      const reader = new Readability(document, { keepClasses: false });
      const article = reader.parse();
      if (article?.textContent && article.textContent.length > 200) {
        text = article.textContent;
      }
    } catch (_) {}

    // Fallback: manual body extraction
    if (!text) {
      const body = document.body;
      if (body) {
        text = body.textContent || "";
      }
    }

    if (!text) return "";

    // Clean up text
    const cleaned = text
      .split("\n")
      .filter((line) => !isBoilerplateLine(line))
      .join("\n")
      .replace(/\t/g, " ")
      .replace(/[ \t]{3,}/g, " ") // collapse long horizontal whitespace
      .replace(/\n{4,}/g, "\n\n\n") // max 3 consecutive newlines
      .trim()
      .slice(0, MAX_CONTENT_CHARS);

    return cleaned;
  } catch (err) {
    console.error("HTML cleaning error:", err.message);
    return "";
  }
}

module.exports = { cleanHtml };
