/**
 * generate_seo_meta.js — Phase 7b
 *
 * Generates AI-written SEO titles/descriptions for Country, Course, and
 * University pages, using generateSeoMeta.js (multi-provider AI client +
 * hard length limits + pre-publish score gate).
 *
 * CONSERVATIVE MERGE — same discipline as every other worker in this
 * project (country/course enrichment, reenrich_partials.js):
 * ONLY overwrites seo.metaTitle/metaDescription when the current value is
 * either missing OR still exactly the old generic-template string that
 * the model's own pre-save hook fills in by default (see
 * models/countries.js, models/courses.js, models/universities.js).
 * A title an admin or a prior run of this script actually wrote is
 * never touched.
 *
 * ROLLOUT STRATEGY (Phase 7, "don't touch everything at once"):
 * Pass --priority-file pointing at the JSON produced by
 * gsc_ctr_tracker.js to process the highest-impression / lowest-CTR
 * pages first. Without it, this script still applies the conservative
 * merge and --limit, but processes matching records in natural (find)
 * order — you should generate a priority file first for anything past
 * a small test batch. This also naturally caps AI-provider cost/load to
 * a meaningful batch instead of regenerating tens of thousands of pages
 * before knowing the approach moves the needle.
 *
 * Usage:
 *   node scripts/generate_seo_meta.js --dry-run --entity country
 *   node scripts/generate_seo_meta.js --entity country --limit 50
 *   node scripts/generate_seo_meta.js --entity university --priority-file ./gsc-priority.json --limit 200
 *   node scripts/generate_seo_meta.js --entity course --force-slug msc-computer-science
 */

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
// NOTE: p-map v7 is ESM-only and breaks under require() in this CommonJS
// codebase. p-limit (already used the same way in relationship-backfill.js
// and unmatched-program-report.js) is the established concurrency-limiting
// pattern here — reused instead of introducing a second, incompatible one.
const pLimit = require("p-limit");

const Country = require("../models/countries");
const Course = require("../models/courses");
const University = require("../models/universities");

const { generateSeoMeta } = require("../ai/generateSeoMeta");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ENTITY_IDX = args.indexOf("--entity");
const ENTITY = ENTITY_IDX !== -1 ? args[ENTITY_IDX + 1] : null; // country | course | university
const LIMIT_IDX = args.indexOf("--limit");
const LIMIT = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1], 10) : 100; // deliberately small default — see rollout strategy
const PRIORITY_FILE_IDX = args.indexOf("--priority-file");
const PRIORITY_FILE =
  PRIORITY_FILE_IDX !== -1 ? args[PRIORITY_FILE_IDX + 1] : null;
const FORCE_SLUG_IDX = args.indexOf("--force-slug");
const FORCE_SLUG = FORCE_SLUG_IDX !== -1 ? args[FORCE_SLUG_IDX + 1] : null;

const CONCURRENCY = 3; // stay well under free-tier provider rate limits

const ENTITY_CONFIG = {
  country: {
    Model: Country,
    populate: [],
    genericTitle: (e) => `Study in ${e.name} | Khizar Overseas`,
  },
  course: {
    Model: Course,
    populate: [],
    genericTitle: (e) =>
      `${e.title} Abroad – Fees, Top Universities & Scope | Khizar Overseas`,
  },
  university: {
    Model: University,
    populate: [{ path: "country", select: "name slug" }],
    genericTitle: (e) => `${e.name} – Admission, Fees & Courses | Khizar Overseas`,
  },
};

function isGenericOrMissing(entityType, entity) {
  const cfg = ENTITY_CONFIG[entityType];
  const currentTitle = (entity.seo?.metaTitle || "").trim();
  if (!currentTitle) return true;
  return currentTitle === cfg.genericTitle(entity);
}

function loadPriorityOrder(entityType) {
  if (!PRIORITY_FILE) return null;
  const raw = JSON.parse(fs.readFileSync(PRIORITY_FILE, "utf8"));
  // Expected shape from gsc_ctr_tracker.js: array of
  // { entityType, slug, impressions, ctr } sorted worst-first.
  const slugs = raw
    .filter((r) => r.entityType === entityType)
    .map((r) => r.slug);

  // BUGFIX: a priority file scoped to a DIFFERENT --entity (e.g. built
  // with `--entity university` but this run passed `--entity country`)
  // previously produced an empty array here, which the caller treated
  // exactly like "no --priority-file was given" — silently falling back
  // to natural DB order with zero warning. That's how a whole batch ran
  // "prioritized" in name only. Fail loudly instead: an explicit
  // --priority-file that matches nothing for this --entity is almost
  // certainly a mistake, not an intentional empty run.
  if (raw.length > 0 && slugs.length === 0) {
    const foundTypes = [...new Set(raw.map((r) => r.entityType))].join(", ");
    throw new Error(
      `--priority-file "${PRIORITY_FILE}" contains 0 entries for ` +
        `--entity ${entityType} (it has entries for: ${foundTypes || "none"}). ` +
        `This looks like a mismatched file, not an intentionally empty one — ` +
        `did you mean --entity ${foundTypes.split(", ")[0]}? Refusing to ` +
        `silently fall back to natural DB order.`,
    );
  }

  return slugs;
}

async function loadCandidates(entityType) {
  const cfg = ENTITY_CONFIG[entityType];

  if (FORCE_SLUG) {
    return cfg.Model.find({ slug: FORCE_SLUG })
      .populate(cfg.populate)
      .exec();
  }

  const priorityOrder = loadPriorityOrder(entityType);

  if (priorityOrder && priorityOrder.length) {
    const docs = await cfg.Model.find({ slug: { $in: priorityOrder } })
      .populate(cfg.populate)
      .exec();
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    // Preserve GSC priority order (highest-impression/lowest-CTR first)
    const ordered = priorityOrder.map((s) => bySlug.get(s)).filter(Boolean);
    return ordered
      .filter((e) => isGenericOrMissing(entityType, e))
      .slice(0, LIMIT);
  }

  // No priority file — natural order, still conservative-merge filtered.
  // Fetch a bit more than LIMIT since some will be filtered out client-side
  // isn't possible for the genericTitle() check (it depends on entity
  // fields), so we query broadly then filter in-memory up to LIMIT.
  const all = await cfg.Model.find({})
    .populate(cfg.populate)
    .limit(LIMIT * 5) // headroom for filtering
    .exec();

  return all.filter((e) => isGenericOrMissing(entityType, e)).slice(0, LIMIT);
}

async function processOne(entityType, entity) {
  try {
    const result = await generateSeoMeta(entityType, entity.toObject());

    if (DRY_RUN) {
      console.log(`\n📍 [${entityType}] ${entity.slug}`);
      console.log(`   old title: ${entity.seo?.metaTitle || "(none)"}`);
      console.log(`   new title (${result.title.length} chars): ${result.title}`);
      console.log(
        `   new desc  (${result.description.length} chars): ${result.description}`,
      );
      console.log(`   score: ${result._score}/${result._maxScore} via ${result._model}`);
      return { status: "dry-run" };
    }

    entity.seo = entity.seo || {};
    entity.seo.metaTitle = result.title;
    entity.seo.metaDescription = result.description;
    entity.seoLastReviewedAt = new Date();
    await entity.save();

    return { status: "updated" };
  } catch (err) {
    console.warn(`❌ [${entityType}] ${entity.slug}: ${err.message}`);
    return { status: "failed", error: err.message };
  }
}

async function main() {
  if (!ENTITY || !ENTITY_CONFIG[ENTITY]) {
    console.error(
      `❌ --entity is required and must be one of: ${Object.keys(ENTITY_CONFIG).join(", ")}`,
    );
    process.exit(1);
  }

  if (!PRIORITY_FILE && !FORCE_SLUG && !DRY_RUN) {
    console.warn(
      "⚠️  No --priority-file given. Per the Phase 7 rollout strategy, run " +
        "gsc_ctr_tracker.js first and pass its output here so the " +
        "highest-impression / lowest-CTR pages get rewritten first. " +
        "Proceeding in natural document order anyway.\n",
    );
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  const candidates = await loadCandidates(ENTITY);
  console.log(
    `📦 ${candidates.length} ${ENTITY} page(s) eligible (missing or generic-template title)${DRY_RUN ? " — DRY RUN" : ""}\n`,
  );

  if (candidates.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let failed = 0;

  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    candidates.map((entity) =>
      limit(async () => {
        const result = await processOne(ENTITY, entity);
        if (result.status === "updated") updated++;
        if (result.status === "failed") failed++;
      }),
    ),
  );

  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Done!`);
  console.log(`   ${DRY_RUN ? "Would update" : "Updated"}: ${updated || candidates.length - failed}`);
  console.log(`   Failed:  ${failed}`);
  if (!DRY_RUN) {
    console.log(
      `\n   Next: let Google recrawl (days to a few weeks), then run ` +
        `gsc_ctr_tracker.js again to measure this batch specifically.`,
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
