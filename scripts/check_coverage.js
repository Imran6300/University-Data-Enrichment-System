/**
 * check_coverage.js — Field coverage audit script
 *
 * Shows how many universities are missing each field, so you can
 * track improvement as re-enrichment runs.
 *
 * Usage:  node scripts/check_coverage.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const University = require("../models/universities");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  const total = await University.countDocuments({});
  const enriched = await University.countDocuments({ isEnriched: true });
  const completed = await University.countDocuments({
    "enrichment.status": "completed",
  });
  const partial = await University.countDocuments({
    "enrichment.status": "partial",
  });
  const failed = await University.countDocuments({
    "enrichment.status": "failed",
  });
  const pending = await University.countDocuments({
    "enrichment.status": "pending",
  });

  console.log("═══════════════════════════════════════════");
  console.log("  UNIVERSITY ENRICHMENT COVERAGE REPORT");
  console.log("═══════════════════════════════════════════");
  console.log(`  Total universities:  ${total}`);
  console.log(`  isEnriched = true:   ${enriched} (${pct(enriched, total)})`);
  console.log(`  Status: completed:   ${completed} (${pct(completed, total)})`);
  console.log(`  Status: partial:     ${partial} (${pct(partial, total)})`);
  console.log(`  Status: failed:      ${failed} (${pct(failed, total)})`);
  console.log(`  Status: pending:     ${pending} (${pct(pending, total)})`);
  console.log("");
  console.log("  FIELD COVERAGE (missing count / % of total)");
  console.log("───────────────────────────────────────────");

  const fields = [
    { name: "description", query: { description: { $in: [null, ""] } } },
    { name: "city", query: { city: { $in: [null, ""] } } },
    { name: "country (ObjectId)", query: { country: null } },
    { name: "tuitionFee", query: { tuitionFee: { $in: [null, ""] } } },
    { name: "totalStudents", query: { totalStudents: { $in: [null, ""] } } },
    { name: "acceptanceRate", query: { acceptanceRate: null } },
    { name: "qsRanking", query: { qsRanking: null } },
    { name: "intakes (empty)", query: { intakes: { $size: 0 } } },
    { name: "programs (empty)", query: { programs: { $size: 0 } } },
    {
      name: "programs (< 3)",
      query: { $expr: { $lt: [{ $size: { $ifNull: ["$programs", []] } }, 3] } },
    },
    {
      name: "admissionReq (empty)",
      query: { admissionRequirements: { $size: 0 } },
    },
    {
      name: "admissionReq (< 3)",
      query: {
        $expr: {
          $lt: [{ $size: { $ifNull: ["$admissionRequirements", []] } }, 3],
        },
      },
    },
    {
      name: "similarUniversities",
      query: {
        $or: [
          { similarUniversities: { $size: 0 } },
          { similarUniversities: null },
        ],
      },
    },
    { name: "logo", query: { "logo.url": { $in: [null, ""] } } },
    { name: "images (empty)", query: { images: { $size: 0 } } },
  ];

  for (const { name, query } of fields) {
    const missing = await University.countDocuments(query);
    const present = total - missing;
    const bar = progressBar(present, total, 20);
    console.log(
      `  ${name.padEnd(26)} ${String(missing).padStart(5)} missing  ${bar}  ${pct(present, total)} filled`,
    );
  }

  // Re-enrichment eligibility
  const eligibleForReEnrich = await University.countDocuments({
    website: { $exists: true, $ne: "" },
    "enrichment.crawlAttempts": { $lt: 4 },
    $or: [
      { "enrichment.status": "partial" },
      { isEnriched: true, tuitionFee: { $in: [null, ""] } },
      { isEnriched: true, totalStudents: { $in: [null, ""] } },
      {
        isEnriched: true,
        $expr: { $lt: [{ $size: { $ifNull: ["$programs", []] } }, 3] },
      },
    ],
  });

  console.log("");
  console.log("  RE-ENRICHMENT");
  console.log("───────────────────────────────────────────");
  console.log(`  Eligible for re-enrichment: ${eligibleForReEnrich}`);
  console.log(`  Run: node scripts/reenrich_partials.js --dry-run`);
  console.log(`  Then: node scripts/reenrich_partials.js`);
  console.log("═══════════════════════════════════════════\n");

  await mongoose.disconnect();
}

function pct(n, total) {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function progressBar(n, total, width) {
  const filled = Math.round((n / Math.max(total, 1)) * width);
  const empty = width - filled;
  return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
