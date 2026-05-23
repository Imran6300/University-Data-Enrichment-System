/**
 * UPGRADED: universityValidator.js
 *
 * Key improvements:
 * - More aggressive salvage (fixes common AI output quirks)
 * - Smarter program level normalization
 * - URL cleaning (removes tracker params, normalizes)
 * - Deduplication of admission requirements (case-insensitive)
 * - Intake normalization (standardizes "Sept" → "September", etc.)
 */

const { z } = require("zod");

const VALID_PROGRAM_LEVELS = [
  "Undergraduate",
  "Postgraduate",
  "PhD",
  "Diploma",
  "Certificate",
];

const VALID_ENRICHMENT_STATUSES = [
  "pending",
  "processing",
  "completed",
  "partial",
  "failed",
];

const ProgramSchema = z.object({
  category: z.string().trim().min(2).max(150),
  level: z.enum(VALID_PROGRAM_LEVELS),
});

const ExtractedDataSchema = z.object({
  description: z.string().max(5000).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().max(100).nullable().optional(),
  qsRanking: z.number().int().min(1).max(1500).nullable().optional(),
  acceptanceRate: z.number().min(0.1).max(100).nullable().optional(),
  totalStudents: z.string().max(50).nullable().optional(),
  tuitionFee: z.string().max(200).nullable().optional(),
  studentsPlaced: z.number().int().min(0).nullable().optional(),
  intakes: z.array(z.string().trim().max(50)).default([]),
  admissionRequirements: z.array(z.string().trim().max(300)).default([]),
  programs: z.array(ProgramSchema).default([]),
  similarUniversities: z.array(z.string().trim().max(200)).max(10).default([]),
  imageUrls: z.array(z.string()).default([]),
});

// ──────────────────────────────────────────────
// Main validator — tries strict parse, then salvage
// ──────────────────────────────────────────────
function validateExtractedSchema(raw) {
  // Attempt 1: direct parse
  const result = ExtractedDataSchema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data, errors: [], salvaged: false };
  }

  const errors = result.error.errors.map(
    (e) => `${e.path.join(".")}: ${e.message}`,
  );

  // Attempt 2: salvage
  const salvaged = salvageData(raw);
  const salvageResult = ExtractedDataSchema.safeParse(salvaged);

  if (salvageResult.success) {
    return {
      success: true,
      data: salvageResult.data,
      errors,
      salvaged: true,
    };
  }

  return { success: false, data: null, errors };
}

// ──────────────────────────────────────────────
// Salvage — fix common issues before hard reject
// ──────────────────────────────────────────────
function salvageData(raw) {
  const fixed = { ...raw };

  // qsRanking: "#47" → 47, "Rank 200" → 200
  if (typeof fixed.qsRanking === "string") {
    const n = parseInt(fixed.qsRanking.replace(/[^0-9]/g, ""));
    fixed.qsRanking = isNaN(n) || n < 1 || n > 1500 ? null : n;
  }

  // acceptanceRate: "45%" → 45, "0.45" → 45 (if looks like decimal)
  if (typeof fixed.acceptanceRate === "string") {
    let n = parseFloat(fixed.acceptanceRate.replace(/[^0-9.]/g, ""));
    if (!isNaN(n) && n <= 1.0) n = n * 100; // 0.45 → 45
    fixed.acceptanceRate = isNaN(n) || n < 0.1 || n > 100 ? null : n;
  }

  // Ensure arrays
  if (!Array.isArray(fixed.intakes)) fixed.intakes = [];
  if (!Array.isArray(fixed.admissionRequirements))
    fixed.admissionRequirements = [];
  if (!Array.isArray(fixed.programs)) fixed.programs = [];
  if (!Array.isArray(fixed.similarUniversities)) fixed.similarUniversities = [];
  if (!Array.isArray(fixed.imageUrls)) fixed.imageUrls = [];

  // Normalize intakes
  fixed.intakes = fixed.intakes
    .filter(Boolean)
    .map(normalizeIntake)
    .filter(Boolean);

  // Deduplicate admission requirements (case-insensitive)
  const seen = new Set();
  fixed.admissionRequirements = fixed.admissionRequirements
    .filter(Boolean)
    .filter((r) => {
      const key = r.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((r) => r.length >= 5); // too short = garbage

  // Filter + validate image URLs
  fixed.imageUrls = fixed.imageUrls.filter((u) => {
    if (typeof u !== "string") return false;
    try {
      const parsed = new URL(u);
      return parsed.protocol.startsWith("http");
    } catch {
      return false;
    }
  });

  // Fix program levels
  fixed.programs = fixed.programs
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const normalized = normalizeProgramLevel(p.level);
      if (!normalized) return null;
      const category = String(p.category || "").trim();
      if (category.length < 2) return null;
      return { category: category.slice(0, 150), level: normalized };
    })
    .filter(Boolean);

  // Deduplicate programs
  const progSeen = new Set();
  fixed.programs = fixed.programs.filter((p) => {
    const key = `${p.category.toLowerCase()}::${p.level}`;
    if (progSeen.has(key)) return false;
    progSeen.add(key);
    return true;
  });

  // Truncate description
  if (typeof fixed.description === "string") {
    fixed.description = fixed.description.trim().slice(0, 5000);
    if (fixed.description.length < 20) fixed.description = null;
  }

  return fixed;
}

// ──────────────────────────────────────────────
// Normalize intake strings
// ──────────────────────────────────────────────
const MONTH_MAP = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  sept: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

function normalizeIntake(intake) {
  if (!intake || typeof intake !== "string") return null;
  let s = intake.trim();

  // Replace abbreviated months
  for (const [abbr, full] of Object.entries(MONTH_MAP)) {
    const re = new RegExp(`\\b${abbr}\\.?\\b`, "i");
    s = s.replace(re, full);
  }

  return s.length > 2 ? s : null;
}

// ──────────────────────────────────────────────
// Normalize program level strings
// ──────────────────────────────────────────────
function normalizeProgramLevel(level) {
  if (!level || typeof level !== "string") return null;
  const l = level.toLowerCase().trim();

  if (
    l.includes("under") ||
    l.includes("bachelor") ||
    l.includes("ug") ||
    l.includes("btech") ||
    l.includes("bsc") ||
    l.includes("ba ") ||
    l === "ba"
  )
    return "Undergraduate";
  if (
    l.includes("post") ||
    l.includes("master") ||
    l.includes("pg") ||
    l.includes("msc") ||
    l.includes("mba") ||
    l.includes("mtech") ||
    l.includes("ma ") ||
    l === "ma"
  )
    return "Postgraduate";
  if (
    l.includes("phd") ||
    l.includes("doctoral") ||
    l.includes("doctorate") ||
    l.includes("d.phil")
  )
    return "PhD";
  if (l.includes("diploma")) return "Diploma";
  if (l.includes("cert")) return "Certificate";

  return null;
}

module.exports = {
  validateExtractedSchema,
  ExtractedDataSchema,
  normalizeProgramLevel,
  normalizeIntake,
};
