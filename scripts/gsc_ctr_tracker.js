/**
 * gsc_ctr_tracker.js — Phase 7c
 *
 * Pulls Google Search Console Pages performance data via the Search
 * Analytics API (see utils/gscClient.js), stores each run durably in
 * Mongo (SeoPerformanceSnapshot), and:
 *   1. diffs a run against the prior one for URLs generate_seo_meta.js
 *      (Phase 7b) has actually rewritten — so "did THIS batch move CTR"
 *      is answerable, separate from site-wide noise.
 *   2. writes a priority file (highest-impression / lowest-CTR pages
 *      first) that generate_seo_meta.js --priority-file consumes, per
 *      the Phase 7 rollout strategy.
 *
 * URL -> entity/slug matching is a lightweight regex classifier here
 * (this script lives in the enrichment repo, not the backend repo, so
 * it doesn't import overseasbackend's seo/urls.js directly) — keep the
 * two in sync if a route shape ever changes on the backend side.
 *
 * Usage:
 *   node scripts/gsc_ctr_tracker.js --pull --days 30
 *   node scripts/gsc_ctr_tracker.js --seed-baseline ./gsc-export-run-zero.csv
 *   node scripts/gsc_ctr_tracker.js --diff run-zero 2026-07-04
 *   node scripts/gsc_ctr_tracker.js --priority-out ./gsc-priority.json --entity university --limit 200
 */

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const { parse: parseCsv } = require("csv-parse/sync");

const SeoPerformanceSnapshot = require("../models/seoPerformanceSnapshot");
const { fetchPagePerformance } = require("../utils/gscClient");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback = null) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : fallback;
};

// ─────────────────────────────────────────────
// URL -> { entityType, slug } classification
// ─────────────────────────────────────────────
function classifyUrl(url) {
  try {
    const path = new URL(url).pathname;

    let m;
    if ((m = path.match(/^\/study-in-([^/]+)\/?$/)))
      return { entityType: "country", slug: m[1] };

    if ((m = path.match(/^\/programs\/universities\/([^/]+)\/?$/)))
      return { entityType: "university", slug: m[1] };

    if ((m = path.match(/^\/courses\/([^/]+)\/?$/)))
      return { entityType: "course", slug: m[1] };

    if ((m = path.match(/^\/blog\/([^/]+)\/?$/)))
      return { entityType: "blog", slug: m[1] };

    if ((m = path.match(/^\/study-(.+)-in-([^/]+)\/?$/)))
      return { entityType: "combo", slug: `${m[1]}::${m[2]}` };

    return { entityType: "other", slug: null };
  } catch (_) {
    return { entityType: "other", slug: null };
  }
}

// ─────────────────────────────────────────────
// --pull: fetch fresh data from the GSC API, store as today's run
// ─────────────────────────────────────────────
async function pull() {
  const days = parseInt(valueOf("--days", "30"), 10);
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);

  const fmt = (d) => d.toISOString().split("T")[0];
  const runLabel = fmt(endDate);

  console.log(
    `📡 Pulling GSC page performance: ${fmt(startDate)} → ${fmt(endDate)}`,
  );
  const rows = await fetchPagePerformance({
    startDate: fmt(startDate),
    endDate: fmt(endDate),
  });
  console.log(`📦 ${rows.length} pages returned`);

  // Look up which URLs have already been through generate_seo_meta.js,
  // so metaRewritten carries forward across runs instead of resetting.
  const previouslyRewritten = new Set(
    (
      await SeoPerformanceSnapshot.find({ metaRewritten: true })
        .select("url")
        .lean()
    ).map((d) => d.url),
  );

  const bulkOps = rows.map((row) => {
    const { entityType, slug } = classifyUrl(row.url);
    return {
      updateOne: {
        filter: { url: row.url, runLabel },
        update: {
          $set: {
            runLabel,
            runDate: endDate,
            url: row.url,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
            entityType,
            slug,
            metaRewritten: previouslyRewritten.has(row.url),
          },
        },
        upsert: true,
      },
    };
  });

  if (bulkOps.length) {
    await SeoPerformanceSnapshot.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(`✅ Stored run "${runLabel}" (${bulkOps.length} pages)`);
  return runLabel;
}

// ─────────────────────────────────────────────
// --seed-baseline: import the original 3-month GSC CSV export as
// "run-zero" — the legitimate "before" baseline referenced in the
// Phase 7 brief. Expects a standard GSC UI "Pages" export CSV with
// columns: Page / Top pages, Clicks, Impressions, CTR, Position.
// ─────────────────────────────────────────────
async function seedBaseline(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const records = parseCsv(raw, { columns: true, skip_empty_lines: true });

  const runLabel = "run-zero";
  const runDate = new Date(); // import time; the CSV itself is the real "as-of" window

  const bulkOps = records.map((r) => {
    const url = r.Page || r["Top pages"] || r.page || r.url;
    const ctrRaw = (r.CTR || r.ctr || "0%").toString().replace("%", "");
    const { entityType, slug } = classifyUrl(url);
    return {
      updateOne: {
        filter: { url, runLabel },
        update: {
          $set: {
            runLabel,
            runDate,
            url,
            clicks: parseInt(r.Clicks || r.clicks || "0", 10),
            impressions: parseInt(r.Impressions || r.impressions || "0", 10),
            ctr: parseFloat(ctrRaw) / 100,
            position: parseFloat(r.Position || r.position || "0"),
            entityType,
            slug,
            metaRewritten: false,
          },
        },
        upsert: true,
      },
    };
  });

  if (bulkOps.length) {
    await SeoPerformanceSnapshot.bulkWrite(bulkOps, { ordered: false });
  }
  console.log(
    `✅ Seeded baseline "run-zero" (${bulkOps.length} pages) from ${csvPath}`,
  );
}

// ─────────────────────────────────────────────
// --diff <runA> <runB>: compare two runs, focused on pages Phase 7b
// actually touched (metaRewritten: true), not site-wide noise.
// ─────────────────────────────────────────────
async function diff(runA, runB) {
  const [before, after] = await Promise.all([
    SeoPerformanceSnapshot.find({ runLabel: runA, metaRewritten: true }).lean(),
    SeoPerformanceSnapshot.find({ runLabel: runB, metaRewritten: true }).lean(),
  ]);

  const beforeByUrl = new Map(before.map((d) => [d.url, d]));
  const rows = [];

  for (const a of after) {
    const b = beforeByUrl.get(a.url);
    if (!b) continue; // only compare URLs present in both runs
    rows.push({
      url: a.url,
      ctrBefore: b.ctr,
      ctrAfter: a.ctr,
      ctrDelta: a.ctr - b.ctr,
      impressionsBefore: b.impressions,
      impressionsAfter: a.impressions,
    });
  }

  rows.sort((x, y) => y.ctrDelta - x.ctrDelta);

  console.log(
    `\n📊 CTR diff for ${rows.length} rewritten page(s): "${runA}" → "${runB}"\n`,
  );
  for (const r of rows) {
    const arrow = r.ctrDelta > 0 ? "▲" : r.ctrDelta < 0 ? "▼" : "─";
    console.log(
      `${arrow} ${(r.ctrDelta * 100).toFixed(2)}pp  ${(r.ctrBefore * 100).toFixed(2)}% → ${(r.ctrAfter * 100).toFixed(2)}%  (${r.impressionsBefore}→${r.impressionsAfter} impr)  ${r.url}`,
    );
  }

  if (rows.length === 0) {
    console.log(
      "No overlapping rewritten pages between these two runs yet. Google " +
        "has to re-crawl a URL before a new title/description can show up " +
        "in the SERP — allow days to a few weeks after generate_seo_meta.js " +
        "runs before expecting movement here.",
    );
  }
}

// ─────────────────────────────────────────────
// --priority-out: highest-impression / lowest-CTR pages first, for
// generate_seo_meta.js --priority-file. This is the Phase 7 rollout
// strategy's actual query against real GSC data, not a guess.
// ─────────────────────────────────────────────
async function priorityOut(outPath) {
  const entityFilter = valueOf("--entity");
  const limit = parseInt(valueOf("--limit", "200"), 10);

  // Use the most recent run available.
  const latestRun = await SeoPerformanceSnapshot.findOne()
    .sort({ runDate: -1 })
    .select("runLabel")
    .lean();

  if (!latestRun) {
    console.error(
      "❌ No snapshots found — run --pull (or --seed-baseline) first.",
    );
    process.exit(1);
  }

  const query = {
    runLabel: latestRun.runLabel,
    slug: { $ne: null },
    ...(entityFilter ? { entityType: entityFilter } : {}),
  };

  const rows = await SeoPerformanceSnapshot.find(query).lean();

  // "Large impressions, low CTR" — the exact pattern the original GSC
  // export showed (Phase 7 brief, Section 2, "Rollout strategy").
  rows.sort((a, b) => {
    // Primary: lowest CTR first. Secondary: highest impressions first.
    if (a.ctr !== b.ctr) return a.ctr - b.ctr;
    return b.impressions - a.impressions;
  });

  const prioritized = rows.slice(0, limit).map((r) => ({
    entityType: r.entityType,
    slug: r.slug,
    impressions: r.impressions,
    ctr: r.ctr,
    url: r.url,
  }));

  fs.writeFileSync(outPath, JSON.stringify(prioritized, null, 2));
  console.log(
    `✅ Wrote ${prioritized.length} prioritized page(s) (run "${latestRun.runLabel}") to ${outPath}`,
  );
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ MongoDB connected\n");

  if (flag("--pull")) {
    await pull();
  } else if (valueOf("--seed-baseline")) {
    await seedBaseline(valueOf("--seed-baseline"));
  } else if (flag("--diff")) {
    const idx = args.indexOf("--diff");
    await diff(args[idx + 1], args[idx + 2]);
  } else if (valueOf("--priority-out")) {
    await priorityOut(valueOf("--priority-out"));
  } else {
    console.log(
      "Usage:\n" +
        "  --pull [--days N]\n" +
        "  --seed-baseline <csvPath>\n" +
        "  --diff <runA> <runB>\n" +
        "  --priority-out <path> [--entity country|course|university] [--limit N]",
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n❌ Fatal:", err.message);
  process.exit(1);
});
