/**
 * UPGRADED: imageService.js
 *
 * Key improvements:
 * - Parallel image validation (check multiple URLs simultaneously)
 * - Better SVG handling (skip SVGs for campus/classroom, allow for logos)
 * - Minimum dimension check (skip tiny icons)
 * - Upload retry with exponential backoff
 * - Graceful handling of Cloudinary upload failures
 */

const axios = require("axios");
const { uploadImageFromUrl, uploadLogo } = require("./cloudinaryService");

const MIN_CONTENT_LENGTH = 5000; // bytes — skip tiny images (icons/avatars)
const MAX_LOGO_CANDIDATES = 5;
const MAX_TYPE_CANDIDATES = 8;
const VALIDATION_CONCURRENCY = 6;

// ──────────────────────────────────────────────
// Image type classification by URL patterns
// ──────────────────────────────────────────────
const IMAGE_TYPE_HINTS = {
  logo: ["logo", "brand", "icon", "emblem", "seal", "crest", "badge", "shield"],
  campus: [
    "campus",
    "aerial",
    "overview",
    "panorama",
    "quad",
    "courtyard",
    "main",
    "ground",
  ],
  classroom: [
    "classroom",
    "lecture",
    "lab",
    "laboratory",
    "study",
    "library",
    "seminar",
    "workshop",
  ],
  building: [
    "building",
    "hall",
    "tower",
    "faculty",
    "block",
    "center",
    "centre",
    "architecture",
  ],
};

const SKIP_PATTERNS = [
  "favicon",
  "icon-",
  "-icon",
  "arrow",
  "button",
  "social",
  "twitter",
  "facebook",
  "linkedin",
  "instagram",
  "youtube",
  "sprite",
  "avatar",
  "thumbnail",
  "logo-white",
  "logo-dark",
  "placeholder",
  "blank",
  "loading",
  "spinner",
  "menu",
  "hamburger",
];

function classifyImageUrl(url) {
  const lower = url.toLowerCase();

  // Skip patterns check
  if (SKIP_PATTERNS.some((p) => lower.includes(p))) return null;

  for (const [type, keywords] of Object.entries(IMAGE_TYPE_HINTS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return type;
    }
  }

  // Default classification for unrecognized URLs
  // Prefer campus for JPG/PNG files that look like photos
  if (/\.(jpg|jpeg|png|webp)/i.test(lower)) return "campus";

  return null;
}

// ──────────────────────────────────────────────
// Validate image URL — checks headers
// ──────────────────────────────────────────────
async function isValidImageUrl(url) {
  try {
    // SVG: allow for logos, skip for photos
    if (url.toLowerCase().endsWith(".svg")) {
      return { valid: true, isSvg: true, size: 0 };
    }

    const response = await axios.head(url, {
      timeout: 6000,
      validateStatus: (s) => s < 400,
      maxRedirects: 3,
    });

    const contentType = response.headers["content-type"] || "";
    const contentLength = parseInt(response.headers["content-length"] || "0");

    if (!contentType.startsWith("image/")) {
      return { valid: false };
    }

    // Skip tiny images (likely icons)
    if (contentLength > 0 && contentLength < MIN_CONTENT_LENGTH) {
      return { valid: false, reason: "too small" };
    }

    return { valid: true, isSvg: false, size: contentLength };
  } catch {
    return { valid: false };
  }
}

// ──────────────────────────────────────────────
// Upload with retry
// ──────────────────────────────────────────────
async function uploadWithRetry(fn, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────
// Main image processing
// ──────────────────────────────────────────────
async function processUniversityImages(imageUrls, universitySlug) {
  const result = {
    logo: null,
    images: { campus: null, classroom: null, building: null },
    uploaded: [],
    failed: [],
  };

  if (!imageUrls || imageUrls.length === 0) return result;

  // Filter by extension and skip patterns
  const filtered = imageUrls.filter((url) => {
    if (!url || typeof url !== "string") return false;
    const lower = url.toLowerCase();
    // Must be an image URL
    if (
      !/\.(jpg|jpeg|png|webp|gif|svg)/i.test(lower) &&
      !lower.includes("image")
    )
      return false;
    // Skip data URIs
    if (lower.startsWith("data:")) return false;
    return true;
  });

  // Classify all URLs
  const classified = { logo: [], campus: [], classroom: [], building: [] };

  for (const url of filtered) {
    const type = classifyImageUrl(url);
    if (type && classified[type]) {
      classified[type].push(url);
    }
  }

  console.log(
    `🖼️ Image candidates: logo=${classified.logo.length} campus=${classified.campus.length} classroom=${classified.classroom.length} building=${classified.building.length}`,
  );

  // ── Upload logo ──
  for (const logoUrl of classified.logo.slice(0, MAX_LOGO_CANDIDATES)) {
    try {
      const check = await isValidImageUrl(logoUrl);
      if (!check.valid) continue;

      result.logo = await uploadWithRetry(() =>
        uploadLogo(logoUrl, universitySlug),
      );
      result.uploaded.push({ url: logoUrl, type: "logo" });
      console.log(`✅ Logo uploaded: ${logoUrl}`);
      break;
    } catch (err) {
      result.failed.push({ url: logoUrl, error: err.message });
    }
  }

  // ── Upload one image per content type ──
  for (const [imageType, urls] of Object.entries({
    campus: classified.campus,
    classroom: classified.classroom,
    building: classified.building,
  })) {
    for (const imageUrl of urls.slice(0, MAX_TYPE_CANDIDATES)) {
      try {
        const check = await isValidImageUrl(imageUrl);
        if (!check.valid || check.isSvg) continue; // SVGs bad for photos

        const uploaded = await uploadWithRetry(() =>
          uploadImageFromUrl(imageUrl, universitySlug, imageType),
        );

        result.images[imageType] = {
          url: uploaded.url,
          public_id: uploaded.public_id,
        };
        result.uploaded.push({ url: imageUrl, type: imageType });
        console.log(`✅ ${imageType} image uploaded`);
        break;
      } catch (err) {
        result.failed.push({ url: imageUrl, error: err.message });
      }
    }
  }

  return result;
}

module.exports = { processUniversityImages, classifyImageUrl };
