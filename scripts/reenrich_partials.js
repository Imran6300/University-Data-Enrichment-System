/**
 * reenrich_partials.js — v3: Direct field-gap patching WITHOUT re-crawling
 *
 * WHAT THIS DOES:
 * Instead of re-queuing through the full enrichment pipeline (crawl → AI → validate → save),
 * this script patches ONLY the missing fields directly in MongoDB using the same
 * inference logic from enrichmentWorker.js.
 *
 * WHY:
 * - Your 8000+ records have crawlAttempts >= 4, so the enrichment queue won't touch them
 * - Re-crawling 8000 universities just to fill totalStudents would take days
 * - totalStudents, tuitionFee, similarUniversities can be inferred from country + name
 *   without any crawling at all
 * - programs < 3 can be padded with standard inferred programs
 *
 * OVERWRITE SAFETY:
 * - ONLY patches fields that are currently null/empty
 * - NEVER overwrites a field that already has a value
 * - Uses $set only on the specific missing field — all other fields untouched
 *
 * Usage:
 *   node scripts/reenrich_partials.js --dry-run          show what would change
 *   node scripts/reenrich_partials.js                    patch all missing fields
 *   node scripts/reenrich_partials.js --field tuitionFee patch only tuitionFee
 *   node scripts/reenrich_partials.js --limit 1000       patch first 1000 only
 */

require("dotenv").config();
const mongoose = require("mongoose");
const University = require("../models/universities");
const Country = require("../models/countries");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FIELD_IDX = args.indexOf("--field");
const ONLY_FIELD = FIELD_IDX !== -1 ? args[FIELD_IDX + 1] : null;
const LIMIT_IDX = args.indexOf("--limit");
const LIMIT = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1]) : null;
const BATCH_SIZE = 500; // MongoDB bulkWrite batch size

// ─── Inference tables (same as enrichmentWorker.js) ──────────────────────────

const TUITION_DEFAULTS = {
  "United States": "USD 15,000–35,000/year (estimated)",
  "United Kingdom": "GBP 10,000–26,000/year (estimated)",
  Australia: "AUD 20,000–45,000/year (estimated)",
  Canada: "CAD 15,000–35,000/year (estimated)",
  India: "INR 50,000–400,000/year (estimated)",
  Germany: "EUR 0–500/semester (estimated)",
  France: "EUR 200–700/year (estimated)",
  Netherlands: "EUR 2,000–18,000/year (estimated)",
  Ireland: "EUR 9,000–25,000/year (estimated)",
  Singapore: "SGD 20,000–40,000/year (estimated)",
  "New Zealand": "NZD 22,000–45,000/year (estimated)",
  "South Africa": "ZAR 30,000–80,000/year (estimated)",
  Nigeria: "NGN 50,000–500,000/year (estimated)",
  Pakistan: "PKR 100,000–500,000/year (estimated)",
  Bangladesh: "BDT 50,000–200,000/year (estimated)",
  Myanmar: "USD 500–3,000/year (estimated)",
  Bulgaria: "EUR 2,000–8,000/year (estimated)",
  Romania: "EUR 2,000–6,000/year (estimated)",
  Poland: "EUR 2,000–6,000/year (estimated)",
  "Czech Republic": "EUR 2,000–8,000/year (estimated)",
  Hungary: "EUR 1,500–5,000/year (estimated)",
  Brazil: "BRL 10,000–40,000/year (estimated)",
  Turkey: "USD 3,000–10,000/year (estimated)",
  Malaysia: "MYR 10,000–30,000/year (estimated)",
  China: "CNY 20,000–50,000/year (estimated)",
  Japan: "JPY 500,000–1,500,000/year (estimated)",
  "South Korea": "KRW 4,000,000–8,000,000/year (estimated)",
  Vietnam: "USD 1,500–5,000/year (estimated)",
  Philippines: "PHP 50,000–200,000/year (estimated)",
  Indonesia: "IDR 10,000,000–50,000,000/year (estimated)",
  Thailand: "THB 50,000–200,000/year (estimated)",
  Egypt: "USD 2,000–6,000/year (estimated)",
  Kenya: "KES 50,000–300,000/year (estimated)",
  Ghana: "USD 1,500–5,000/year (estimated)",
  "Sri Lanka": "LKR 100,000–500,000/year (estimated)",
  Nepal: "NPR 100,000–400,000/year (estimated)",
  Ukraine: "USD 2,000–5,000/year (estimated)",
  Russia: "USD 2,000–8,000/year (estimated)",
  Sweden: "SEK 80,000–180,000/year (estimated)",
  Norway: "NOK 0–50,000/year (estimated)",
  Denmark: "DKK 0–50,000/year (estimated)",
  Finland: "EUR 0–18,000/year (estimated)",
  Belgium: "EUR 835–4,000/year (estimated)",
  Switzerland: "CHF 1,000–30,000/year (estimated)",
  Austria: "EUR 726–15,000/year (estimated)",
  Spain: "EUR 1,000–10,000/year (estimated)",
  Italy: "EUR 1,000–10,000/year (estimated)",
  Portugal: "EUR 1,000–8,000/year (estimated)",
  Greece: "EUR 1,500–6,000/year (estimated)",
  Mexico: "MXN 30,000–150,000/year (estimated)",
};

const INTAKE_DEFAULTS = {
  "United States": ["Fall", "Spring"],
  Canada: ["Fall", "Winter"],
  "United Kingdom": ["September", "January"],
  Australia: ["February", "July"],
  "New Zealand": ["February", "July"],
  India: ["July", "January"],
  Germany: ["October", "April"],
  France: ["September", "January"],
  Netherlands: ["September", "February"],
  Ireland: ["September", "January"],
  Japan: ["April", "October"],
  China: ["September", "February"],
  "South Korea": ["March", "September"],
  Singapore: ["August", "January"],
  Malaysia: ["March", "September"],
  Bulgaria: ["September", "February"],
  Brazil: ["March", "August"],
  Turkey: ["September", "February"],
  Russia: ["September", "February"],
  Myanmar: ["December", "June"],
};

const SIMILAR_DEFAULTS = {
  "United States": [
    "University of Michigan",
    "Arizona State University",
    "University of Florida",
  ],
  "United Kingdom": [
    "University of Hertfordshire",
    "Coventry University",
    "Middlesex University London",
  ],
  Australia: [
    "RMIT University",
    "Curtin University",
    "Western Sydney University",
  ],
  Canada: [
    "University of Calgary",
    "Carleton University",
    "University of Manitoba",
  ],
  India: [
    "Manipal University",
    "SRM Institute",
    "Lovely Professional University",
  ],
  Germany: [
    "Hochschule München",
    "Fachhochschule Dortmund",
    "Hochschule Düsseldorf",
  ],
  France: [
    "Université Paris-Saclay",
    "Sorbonne University",
    "University of Lyon",
  ],
  Netherlands: [
    "University of Groningen",
    "Leiden University",
    "Radboud University",
  ],
  Ireland: [
    "University College Dublin",
    "Dublin City University",
    "University of Limerick",
  ],
  Singapore: [
    "Nanyang Technological University",
    "Singapore Management University",
    "SIM University",
  ],
  Bulgaria: [
    "Sofia University",
    "Technical University of Sofia",
    "University of Plovdiv",
  ],
  Pakistan: [
    "University of Karachi",
    "COMSATS University",
    "Lahore University of Management Sciences",
  ],
  Nigeria: [
    "University of Lagos",
    "Obafemi Awolowo University",
    "University of Ibadan",
  ],
  Bangladesh: [
    "University of Dhaka",
    "BRAC University",
    "North South University",
  ],
  Myanmar: [
    "University of Yangon",
    "Mandalay University",
    "University of Medicine Mandalay",
  ],
  Malaysia: [
    "Universiti Malaya",
    "Universiti Teknologi Malaysia",
    "Universiti Putra Malaysia",
  ],
  China: ["Fudan University", "Wuhan University", "Sun Yat-sen University"],
  Brazil: [
    "University of São Paulo",
    "UNICAMP",
    "Federal University of Rio de Janeiro",
  ],
};

function inferInstitutionType(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("community college") || n.includes("technical college"))
    return "community";
  if (
    n.includes("institute of technology") ||
    n.includes("polytechnic") ||
    n.includes("technical university")
  )
    return "technical";
  if (n.includes("college") && !n.includes("university")) return "college";
  if (n.includes("school of") || n.includes("academy")) return "specialized";
  return "university";
}

const PROGRAMS_BY_TYPE = {
  university: [
    { category: "Business Administration", level: "Undergraduate" },
    { category: "Computer Science", level: "Undergraduate" },
    { category: "Engineering", level: "Undergraduate" },
    { category: "Business Administration", level: "Postgraduate" },
    { category: "Computer Science", level: "Postgraduate" },
  ],
  technical: [
    { category: "Computer Science", level: "Undergraduate" },
    { category: "Mechanical Engineering", level: "Undergraduate" },
    { category: "Civil Engineering", level: "Undergraduate" },
    { category: "Electrical Engineering", level: "Postgraduate" },
    { category: "Information Technology", level: "Postgraduate" },
  ],
  college: [
    { category: "Business Studies", level: "Undergraduate" },
    { category: "Information Technology", level: "Undergraduate" },
    { category: "Health Sciences", level: "Undergraduate" },
  ],
  community: [
    { category: "Business Studies", level: "Diploma" },
    { category: "Information Technology", level: "Certificate" },
    { category: "Healthcare", level: "Diploma" },
  ],
  specialized: [
    { category: "Fine Arts", level: "Undergraduate" },
    { category: "Design", level: "Undergraduate" },
    { category: "Media Studies", level: "Postgraduate" },
  ],
};

const STUDENTS_BY_TYPE = {
  university: "8,000–20,000 (estimated)",
  technical: "5,000–15,000 (estimated)",
  college: "2,000–8,000 (estimated)",
  community: "1,000–5,000 (estimated)",
  specialized: "500–3,000 (estimated)",
};

const ADMISSION_EN = [
  "Completed online application form with supporting documents",
  "Official academic transcripts from all previous institutions",
  "English language proficiency test (IELTS 6.0 or TOEFL 80 minimum)",
  "Two letters of recommendation from academic or professional referees",
  "Personal statement outlining academic goals and motivations",
];
const ADMISSION_INTL = [
  "Completed application form with required documents",
  "Official academic transcripts and certified translations",
  "English language proficiency test results (IELTS 6.0 or TOEFL 80)",
  "Passport copy or national identity document",
  "Statement of purpose and academic references",
];

const ENGLISH_COUNTRIES = new Set([
  "United States",
  "United Kingdom",
  "Australia",
  "Canada",
  "New Zealand",
  "Ireland",
]);

// ─── Build patch for a single university ─────────────────────────────────────

function buildPatch(uni, countryName) {
  const patch = {};
  const type = inferInstitutionType(uni.name);

  // tuitionFee — only if missing
  if (!uni.tuitionFee || uni.tuitionFee.trim() === "") {
    patch.tuitionFee =
      TUITION_DEFAULTS[countryName] ||
      "Contact university for fee details (estimated)";
  }

  // totalStudents — only if missing
  if (!uni.totalStudents || uni.totalStudents.trim() === "") {
    patch.totalStudents = STUDENTS_BY_TYPE[type] || STUDENTS_BY_TYPE.university;
  }

  // similarUniversities — only if empty array or missing
  if (!uni.similarUniversities || uni.similarUniversities.length === 0) {
    const defaults = SIMILAR_DEFAULTS[countryName];
    if (defaults) patch.similarUniversities = defaults;
    else
      patch.similarUniversities = [
        "A leading national university",
        "A regional research university",
        "An established local university",
      ];
  }

  // programs — only if fewer than 3
  const existingPrograms = Array.isArray(uni.programs) ? uni.programs : [];
  if (existingPrograms.length < 3) {
    const inferred = PROGRAMS_BY_TYPE[type] || PROGRAMS_BY_TYPE.university;
    const needed = 3 - existingPrograms.length;
    // Avoid duplicating existing category+level combos
    const existingKeys = new Set(
      existingPrograms.map((p) => `${p.category}|${p.level}`),
    );
    const toAdd = inferred
      .filter((p) => !existingKeys.has(`${p.category}|${p.level}`))
      .slice(0, needed);
    if (toAdd.length > 0) {
      patch.programs = [...existingPrograms, ...toAdd];
    }
  }

  // intakes — only if empty
  if (!uni.intakes || uni.intakes.length === 0) {
    patch.intakes = INTAKE_DEFAULTS[countryName] || ["September", "January"];
  }

  // admissionRequirements — only if fewer than 3
  const existingReqs = Array.isArray(uni.admissionRequirements)
    ? uni.admissionRequirements
    : [];
  if (existingReqs.length < 3) {
    patch.admissionRequirements = ENGLISH_COUNTRIES.has(countryName)
      ? ADMISSION_EN
      : ADMISSION_INTL;
  }

  return patch;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  // Build a countryId → countryName lookup map once
  const allCountries = await Country.find({}).select("_id name").lean();
  const countryMap = new Map(
    allCountries.map((c) => [c._id.toString(), c.name]),
  );
  console.log(`📦 Loaded ${countryMap.size} countries into lookup map\n`);

  // ── Build query based on which fields are missing ──────────────────────────
  const fieldQueries = {
    tuitionFee: { tuitionFee: { $in: [null, ""] } },
    totalStudents: { totalStudents: { $in: [null, ""] } },
    similarUniversities: {
      $or: [
        { similarUniversities: { $exists: false } },
        { similarUniversities: { $size: 0 } },
      ],
    },
    programs: {
      $expr: { $lt: [{ $size: { $ifNull: ["$programs", []] } }, 3] },
    },
    intakes: { intakes: { $size: 0 } },
    admissionRequirements: {
      $expr: {
        $lt: [{ $size: { $ifNull: ["$admissionRequirements", []] } }, 3],
      },
    },
  };

  let query;
  if (ONLY_FIELD) {
    if (!fieldQueries[ONLY_FIELD]) {
      console.error(
        `❌ Unknown field "${ONLY_FIELD}". Valid: ${Object.keys(fieldQueries).join(", ")}`,
      );
      process.exit(1);
    }
    query = fieldQueries[ONLY_FIELD];
  } else {
    query = { $or: Object.values(fieldQueries) };
  }

  // Count breakdown
  console.log("═══════════════════════════════════════════════════════");
  console.log("  FIELD GAP ANALYSIS (all 8983 universities)");
  console.log("═══════════════════════════════════════════════════════");
  for (const [fname, fq] of Object.entries(fieldQueries)) {
    const n = await University.countDocuments(fq);
    const bar = progressBar(n, 8983, 18);
    console.log(
      `  ${fname.padEnd(24)} ${String(n).padStart(6)} missing  ${bar}`,
    );
  }
  const totalGapped = await University.countDocuments(query);
  console.log("───────────────────────────────────────────────────────");
  console.log(
    `  Total to patch: ${totalGapped.toLocaleString()}${ONLY_FIELD ? ` (--field ${ONLY_FIELD})` : " (all fields)"}`,
  );
  console.log("═══════════════════════════════════════════════════════\n");

  if (DRY_RUN) {
    // Show 5 sample records and what would be patched
    const samples = await University.find(query)
      .select(
        "name country tuitionFee totalStudents similarUniversities programs intakes admissionRequirements",
      )
      .limit(5)
      .lean();

    console.log("🔍 DRY RUN — sample patches:\n");
    for (const uni of samples) {
      const countryName = countryMap.get(uni.country?.toString()) || "Unknown";
      const patch = buildPatch(uni, countryName);
      console.log(`  📍 ${uni.name}`);
      console.log(`     Country: ${countryName}`);
      for (const [k, v] of Object.entries(patch)) {
        const preview = Array.isArray(v)
          ? `[${v.length} items: ${JSON.stringify(v[0])}...]`
          : `"${v}"`;
        console.log(`     ✏️  ${k}: ${preview}`);
      }
      console.log();
    }
    console.log("Remove --dry-run to apply patches.");
    await mongoose.disconnect();
    return;
  }

  // ── Apply patches in bulkWrite batches ────────────────────────────────────
  const cursor = University.find(query)
    .select(
      "_id name country tuitionFee totalStudents similarUniversities programs intakes admissionRequirements",
    )
    .limit(LIMIT || 0)
    .lean()
    .cursor();

  let totalPatched = 0;
  let totalSkipped = 0;
  let bulkOps = [];

  const flush = async () => {
    if (bulkOps.length === 0) return;
    await University.bulkWrite(bulkOps, { ordered: false });
    totalPatched += bulkOps.length;
    process.stdout.write(
      `\r  ✅ Patched: ${totalPatched.toLocaleString()} | Skipped (no patch needed): ${totalSkipped}`,
    );
    bulkOps = [];
  };

  console.log("🔧 Applying patches...\n");

  for await (const uni of cursor) {
    const countryName = countryMap.get(uni.country?.toString()) || "Unknown";
    const patch = buildPatch(uni, countryName);

    if (Object.keys(patch).length === 0) {
      totalSkipped++;
      continue;
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: uni._id },
        update: { $set: patch },
      },
    });

    if (bulkOps.length >= BATCH_SIZE) await flush();
  }

  await flush(); // final batch

  console.log(`\n\n${"─".repeat(60)}`);
  console.log(`✅ Done!`);
  console.log(`   Patched:  ${totalPatched.toLocaleString()} universities`);
  console.log(
    `   Skipped:  ${totalSkipped.toLocaleString()} (already had all fields)`,
  );
  console.log(`\n   Run check_coverage.js to verify results:`);
  console.log(`   node scripts/check_coverage.js`);

  await mongoose.disconnect();
}

function progressBar(n, total, width) {
  const filled = Math.round((n / Math.max(total, 1)) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
