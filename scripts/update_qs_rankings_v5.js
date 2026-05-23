/**
 * ============================================================
 * QS Rankings Updater — FINAL v5 (definitive)
 * ============================================================
 * Strategy:
 *   1. Exact normalised match against CSV
 *   2. Curated alias map (DB name → CSV exact parsed name)
 *   3. No match → qsRanking: null
 *
 * HOW TO RUN:
 *   npm install mongoose csv-parse
 *   node update_qs_rankings_v5.js           ← dry run
 *   node update_qs_rankings_v5.js --apply   ← write to DB
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");

// ── CONFIG ────────────────────────────────────────────────────
const MONGO_URI =
  "mongodb+srv://SyedMubashirAhmed1425:f9BbjOxlGkVFMKrl@overseas.iwwlhej.mongodb.net/overseas";
const COLLECTION = "universities";
// ─────────────────────────────────────────────────────────────

const DRY_RUN = !process.argv.includes("--apply");
const csvArg = process.argv.find((a) => a.startsWith("--csv="));
const CSV_PATH = csvArg
  ? csvArg.split("=")[1]
  : path.join(__dirname, "../data/qs-world-rankings-2025.csv");

// ── ALIAS MAP ─────────────────────────────────────────────────
// Key   = exact DB university name
// Value = exact Institution Name as csv-parse produces it from the CSV
//         (quotes are removed by csv-parse for properly quoted fields)
const ALIAS_MAP = {
  // ── Australia ──────────────────────────────────────────────
  "Australian National University": "The Australian National University",
  "University of Melbourne": "The University of Melbourne",
  "University of New South Wales":
    "The University of New South Wales (UNSW Sydney)",
  "University of Queensland": "The University of Queensland",
  "University of Sydney": "The University of Sydney",
  "University of Western Australia": "The University of Western Australia",
  "University of Adelaide": "The University of Adelaide",
  "Flinders University of South Australia": "Flinders University",
  "James Cook University of North Queensland": "James Cook University",
  "University of Western Sydney": "Western Sydney University",
  // AU Newcastle → maps to AU entry (rank 179)
  "University of Newcastle": "The University of Newcastle, Australia (UON)",

  // ── New Zealand ────────────────────────────────────────────
  "University of Auckland": "The University of Auckland",
  // Canterbury CSV has special chars — match via normalisation already works if not, alias covers it
  "University of Canterbury":
    "University of Canterbury | Te Whare W\u0101nanga o Waitaha",

  // ── UK ─────────────────────────────────────────────────────
  "University of Edinburgh": "The University of Edinburgh",
  "University of Exeter": "The University of Exeter",
  "University of Manchester": "The University of Manchester",
  "University of Warwick": "The University of Warwick",
  "University of Durham": "Durham University",
  "University of Lancaster": "Lancaster University",
  "King's College London, University of London": "King's College London",
  "London School of Economics and Political Science, University of London":
    "The London School of Economics and Political Science (LSE)",
  "University College London, University of London": "UCL",
  "Queen Mary, University of London": "Queen Mary University of London",
  "The Queen's University Belfast": "Queen's University Belfast",
  "The Manchester Metropolitan University":
    "Manchester Metropolitan University (MMU)",
  "The Robert Gordon University": "Robert Gordon University",
  "Northumbria University": "Northumbria University at Newcastle",
  "De Montfort University Leicester": "De Montfort University",
  "University of Kent at Canterbury": "University of Kent",
  "University of the West of England, Bristol":
    "University of the West of England",
  "South Bank University": "London South Bank University",
  "Middlesex University - London": "Middlesex University",
  // These CSV entries are properly quoted so csv-parse gives clean names:
  "University of Essex": "Essex, University of",
  "Birkbeck College, University of London": "Birkbeck, University of London",
  "Goldsmiths College, University of London":
    "Goldsmiths, University of London",
  "University of Dublin, Trinity College":
    "Trinity College Dublin, The University of Dublin",
  "Kingston University": "Kingston University, London",

  // ── Switzerland ────────────────────────────────────────────
  "ETH Zurich": "ETH Zurich - Swiss Federal Institute of Technology",
  "EPFL - EPF Lausanne": "EPFL",

  // ── Germany ────────────────────────────────────────────────
  "Humboldt Universität Berlin": "Humboldt-Universität zu Berlin",
  "Bayerische Julius-Maximilians-Universität Würzburg":
    "Julius-Maximilians-Universität Würzburg",
  "Universität Kaiserslautern": "Technische Universität Kaiserslautern",
  "Friedrich-Schiller Universität Jena": "Universität Jena",

  // ── France ─────────────────────────────────────────────────
  "Université Claude Bernard (Lyon I)": "Université Claude Bernard Lyon 1",
  "Université Jean Moulin (Lyon III)": "Université Jean Moulin Lyon 3",
  "Université Paul Sabatier (Toulouse III)":
    "Université Paul Sabatier Toulouse III",
  "Université Rennes I": "Université de Rennes 1 (University of Rennes)",
  "Université de Toulouse-le-Mirail (Toulouse II)":
    "Université de Toulouse II-Le Mirail",
  "Université de Toulouse-le-Mirail (Toulouse III)":
    "Université Paul Sabatier Toulouse III",
  "Université de Toulouse": "Université Paul Sabatier Toulouse III",
  "Institut National des Sciences Appliquées de Rennes":
    "Institut National des Sciences Appliquées de Lyon (INSA)",
  "Institut National des Sciences Appliquées de Rouen":
    "Institut National des Sciences Appliquées de Lyon (INSA)",
  "Institut National des Sciences Appliquées de Toulouse":
    "Institut National des Sciences Appliquées de Lyon (INSA)",

  // ── Egypt ──────────────────────────────────────────────────
  "American University in Cairo": "The American University in Cairo",

  // ── Israel ─────────────────────────────────────────────────
  "Hebrew University of Jerusalem": "The Hebrew University of Jerusalem",

  // ── Italy ──────────────────────────────────────────────────
  "University of Bologna": "Alma Mater Studiorum - University of Bologna",
  "University of Milan - Bicocca": "University of Milano-Bicocca",
  "University of Venice": "Ca' Foscari University of Venice",
  "University of Verona": "Verona University",
  "University of Catania": "Catania University",
  "University of Modena": "University of Modena and Reggio Emilia",
  "Free University of Bozen": "Free University of Bozen-Bolzano",

  // ── Georgia ────────────────────────────────────────────────
  "Tbilisi State University": "Ivane Javakhishvili Tbilisi State University",

  // ── Jordan ─────────────────────────────────────────────────
  "Hashemite University": "The Hashemite University",
  "Jordan University of Science and Technology":
    "Jordan University of Science & Technology",

  // ── Norway ─────────────────────────────────────────────────
  "University of Tromsø":
    "University of Tromsø The Arctic University of Norway",

  // ── Denmark ────────────────────────────────────────────────
  "University of Southern Denmark - SDU":
    "University of Southern Denmark (SDU)",
  "IT University of Copenhagen": "University of Copenhagen",

  // ── Romania / Slovakia ─────────────────────────────────────
  "Comenius University in Bratislava": "Comenius University Bratislava",
  "Technical University in Kosice": "Technical University of Kosice",
  "Babes-Bolyai University of Cluj-Napoca": "Babes-Bolyai University",
  "West University of Timisoara":
    "Universitatea de Vest din Timisoara / West University of Timisoara",

  // ── Spain ──────────────────────────────────────────────────
  "Universidad de Alcalá de Henares": "Universidad de Alcalá",
  "Universitat Rovira I Virgili Tarragona": "Universitat Rovira i Virgili",
  "La Salle - Universitat Ramon Llull": "Universitat Ramon Llull",

  // ── Singapore ──────────────────────────────────────────────
  // csv-parse produces: "Nanyang Technological University, Singapore (NTU)"
  "Nanyang Technological University":
    "Nanyang Technological University, Singapore (NTU)",

  // ── Hong Kong ──────────────────────────────────────────────
  "Lingnan University": "Lingnan University, Hong Kong",

  // ── Japan ──────────────────────────────────────────────────
  "University of Tokyo": "The University of Tokyo",
  "Tsukuba University": "University of Tsukuba",
  "Tampere University of Technology": "Tampere University",
  "University of Tampere": "Tampere University",

  // ── Malaysia ───────────────────────────────────────────────
  "Universiti Teknologi Mara": "Universiti Teknologi MARA - UiTM",
  "Taylor's University College": "Taylor's University",
  "Asia Pacific University of Technology & Innovation (APU)":
    "Asia Pacific University of Technology and Innovation (APU)",
  "Sunway University College": "Sunway University",
  "Monash University, Malaysia Campus": "Monash University",
  "University of Nottingham, Malaysia Campus": "University of Nottingham",
  "Newcastle University, Medicine Malaysia": "Newcastle University",
  "Swinburne University of Technology, Sarawak Campus":
    "Swinburne University of Technology",
  "Curtin University of Technology, Sarawak Campus": "Curtin University",
  "Universiti Tun Hussein Onn Malaysia":
    "Universiti Tun Hussein Onn University of Malaysia (UTHM)",

  // ── Canada ─────────────────────────────────────────────────
  "Queen's University": "Queen's University at Kingston",
  "University of Toronto, Scarborough": "University of Toronto",
  "University of Toronto, Mississauga": "University of Toronto",
  "Victoria University Toronto, University of Toronto": "University of Toronto",
  "University of New Brunswick, Saint John": "University of New Brunswick",
  "École Polytechnique de Montréal, Université de Montréal":
    "Université de Montréal",
  "Concordia University College of Alberta": "Concordia University",
  "École nationale d'administration publique, Université du Québec":
    "Université du Québec",
  "École de technologie supérieure, Université du Québec":
    "Université du Québec",
  "Institut Armand-Frappier, Université du Québec": "Université du Québec",
  "Institut National de la Recherche Scientifique, Université du Québec":
    "Université du Québec",
  "Télé-université, Université du Québec": "Université du Québec",
  "Université du Québec à Chicoutimi": "Université du Québec",
  "Université du Québec à Montréal": "Université du Québec",
  "Université du Québec à Rimouski": "Université du Québec",
  "Université du Québec en Abitibi-Témiscamingue": "Université du Québec",
  "Université du Québec en Outaouais": "Université du Québec",
  "Université du Québec à Trois-Rivières": "Université du Québec",

  // ── Netherlands ────────────────────────────────────────────
  "Wageningen University": "Wageningen University & Research",

  // ── India ──────────────────────────────────────────────────
  "Jamia Millia Islamia University": "Jamia Millia Islamia",
  "Jamia Hamdard University": "Jamia Hamdard",
  "Symbiosis International University":
    "Symbiosis International (Deemed University)",
  "SRM Institute Of Science & Technology":
    "SRM INSTITUTE OF SCIENCE AND TECHNOLOGY",
  "Thapar Institute of Engineering and Technology":
    "Thapar Institute of Engineering & Technology",

  // ── UAE ────────────────────────────────────────────────────
  "Khalifa University": "Khalifa University of Science and Technology",
  "Khalifa University of Science, Technology and Research":
    "Khalifa University of Science and Technology",
  "New York University, Abu Dhabi": "New York University (NYU)",
  "University of Wollongong - Dubai Campus": "University of Wollongong",
  "Paris-Sorbonne University Abu Dhabi": "Sorbonne University",

  // ── Poland ─────────────────────────────────────────────────
  "Jagiellonian University Cracow": "Jagiellonian University",
  "Nicolaus Copernicus University of Torun": "Nicolaus Copernicus University",
  "University of Silesia": "University of Silesia in Katowice",
  "Agricultural University of Warsaw":
    "Warsaw University of Life Sciences \u2013 SGGW (WULS-SGGW)",
  "Technical University of Gdansk": "Gda\u0144sk University of Technology",
  "Technical University of Wroclaw":
    "Wroclaw University of Science and Technology (WRUST)",
  "Technical University of Lodz": "Lodz University of Technology",
  "Agricultural University of Wroclaw": "University of Wroclaw",

  // ── Ukraine ────────────────────────────────────────────────
  "National University of Kiev-Mohyla Academy":
    "National University of Kyiv-Mohyla Academy (NaUKMA)",
  "Lviv National University Ivan Franko":
    "Ivan Franko National University of Lviv",
};

// ── Normalise ─────────────────────────────────────────────────
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[''""".,\-\u2013\u2014\/&|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Load CSV ──────────────────────────────────────────────────
function loadCsv(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const records = parse(fs.readFileSync(csvPath), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const byNorm = new Map(); // normalised → {originalName, rank}
  const byOriginal = new Map(); // exact parsed name → rank

  for (const row of records) {
    const name = (row["Institution Name"] || "").trim();
    const rank = (row["2025 Rank"] || "").trim();
    if (!name || !rank) continue;

    const norm = normalize(name);
    if (!byNorm.has(norm)) byNorm.set(norm, { originalName: name, rank });
    if (!byOriginal.has(name)) byOriginal.set(name, rank);
  }

  return { byNorm, byOriginal };
}

// ── Match ─────────────────────────────────────────────────────
function findMatch(dbName, byNorm, byOriginal) {
  // 1. Exact normalised match
  const normDb = normalize(dbName);
  if (byNorm.has(normDb)) {
    return { ...byNorm.get(normDb), confidence: "exact" };
  }

  // 2. Alias map
  const aliasTarget = ALIAS_MAP[dbName];
  if (aliasTarget !== undefined) {
    // Try exact original name
    if (byOriginal.has(aliasTarget)) {
      return {
        originalName: aliasTarget,
        rank: byOriginal.get(aliasTarget),
        confidence: "alias",
      };
    }
    // Try normalised alias target
    const normAlias = normalize(aliasTarget);
    if (byNorm.has(normAlias)) {
      return { ...byNorm.get(normAlias), confidence: "alias" };
    }
    // Alias target not in CSV → not QS-ranked → null
    return null;
  }

  return null;
}

// ── Mongoose schema ───────────────────────────────────────────
const uniSchema = new mongoose.Schema(
  { name: String, qsRanking: mongoose.Schema.Types.Mixed },
  { strict: false, collection: COLLECTION },
);
const University = mongoose.model("University", uniSchema);

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log("\n========================================");
  console.log("QS Rankings Updater — FINAL v5");
  console.log(
    `Mode : ${DRY_RUN ? "DRY RUN — no writes" : "LIVE — writing to DB"}`,
  );
  console.log(`CSV  : ${CSV_PATH}`);
  console.log("========================================\n");

  const { byNorm, byOriginal } = loadCsv(CSV_PATH);
  console.log(`✔ Loaded ${byNorm.size} entries from CSV\n`);

  await mongoose.connect(MONGO_URI);
  console.log(`✔ Connected to MongoDB\n`);

  const universities = await University.find(
    {},
    { name: 1, qsRanking: 1 },
  ).lean();
  console.log(`✔ Found ${universities.length} universities in DB\n`);

  const toUpdate = [];
  const toNull = [];
  const alreadyCorrect = [];
  const alreadyNull = [];
  const bulkOps = [];

  for (const uni of universities) {
    const dbName = (uni.name || "").trim();
    const match = findMatch(dbName, byNorm, byOriginal);

    if (!match) {
      const cur = uni.qsRanking;
      const isNull = cur === null || cur === undefined || cur === "";
      if (isNull) {
        alreadyNull.push(dbName);
      } else {
        toNull.push({ id: uni._id, name: dbName, fakeRank: cur });
        if (!DRY_RUN) {
          bulkOps.push({
            updateOne: {
              filter: { _id: uni._id },
              update: { $set: { qsRanking: null } },
            },
          });
        }
      }
      continue;
    }

    const cur = String(uni.qsRanking ?? "");
    const newRank = String(match.rank);

    if (cur === newRank) {
      alreadyCorrect.push({ name: dbName, rank: newRank });
    } else {
      toUpdate.push({
        id: uni._id,
        name: dbName,
        matchedTo: match.originalName,
        confidence: match.confidence,
        oldRank: uni.qsRanking,
        newRank,
      });
      if (!DRY_RUN) {
        bulkOps.push({
          updateOne: {
            filter: { _id: uni._id },
            update: { $set: { qsRanking: newRank } },
          },
        });
      }
    }
  }

  if (!DRY_RUN && bulkOps.length > 0) {
    const result = await University.bulkWrite(bulkOps, { ordered: false });
    console.log(`✔ bulkWrite: ${result.modifiedCount} documents modified\n`);
  }

  // ── Report ────────────────────────────────────────────────
  console.log(
    `── RANK UPDATED (${toUpdate.length}) ──────────────────────────────────`,
  );
  for (const r of toUpdate) {
    console.log(`  ✓ "${r.name}"`);
    console.log(`      → "${r.matchedTo}"  [${r.confidence}]`);
    console.log(`      ${JSON.stringify(r.oldRank)} → "${r.newRank}"`);
  }

  console.log(
    `\n── FAKE RANK → NULL (${toNull.length}) ──────────────────────────────`,
  );
  for (const r of toNull) {
    console.log(`  ✗ "${r.name}"  was: ${JSON.stringify(r.fakeRank)} → null`);
  }

  console.log(
    `\n── ALREADY CORRECT (${alreadyCorrect.length}) ────────────────────────`,
  );
  console.log(
    `\n── ALREADY NULL (${alreadyNull.length}) ──────────────────────────────`,
  );

  console.log("\n========================================");
  console.log("SUMMARY");
  console.log(`  Total in DB          : ${universities.length}`);
  console.log(`  Rank updated         : ${toUpdate.length}`);
  console.log(`  Fake rank → null     : ${toNull.length}`);
  console.log(`  Already correct      : ${alreadyCorrect.length}`);
  console.log(`  Already null         : ${alreadyNull.length}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing written.");
    console.log("  Run with: node update_qs_rankings_v5.js --apply");
  } else {
    console.log(`\n  ✔  ${toUpdate.length + toNull.length} records modified.`);
  }
  console.log("========================================\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
