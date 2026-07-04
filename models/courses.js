/** ⚠️  AUTO-SYNCED FILE — DO NOT EDIT DIRECTLY
 * Source of truth: config/models/courses.js (Phase 3 schema sync)
 * Edit that file instead, then run: node scripts/syncSchemas.js --apply
 * (config repo: overseasbackend) */

const mongoose = require("mongoose");
const { Schema } = mongoose;
const slugify = require("slugify");

// ─────────────────────────────────────────────
// Existing Sub-Schema (untouched)
// ─────────────────────────────────────────────

const EntryRequirementSchema = new Schema({
  title: { type: String, trim: true },
  description: { type: String, trim: true },
});

// ─────────────────────────────────────────────
// NEW ▸ SEO Sub-Schemas
// ─────────────────────────────────────────────

const SocialMetaSchema = new Schema(
  {
    ogTitle: { type: String, maxlength: 95, trim: true },
    ogDescription: { type: String, maxlength: 200, trim: true },
    ogImage: { url: String, public_id: String },
    twitterTitle: { type: String, maxlength: 70, trim: true },
    twitterDescription: { type: String, maxlength: 200, trim: true },
  },
  { _id: false },
);

/**
 * Structured data hints for Course JSON-LD.
 * Maps to schema.org/Course
 */
const StructuredDataSchema = new Schema(
  {
    /** schema.org/CourseInstance – delivery mode */
    courseMode: {
      type: String,
      enum: ["onsite", "online", "blended"],
      trim: true,
    },
    /** ECTS or local credit hours */
    creditHours: { type: String, trim: true },
    /** ISCED level code, e.g. "6" for bachelor */
    iscedLevel: { type: String, trim: true },
    /** Awarding organization name (often same as university) */
    provider: { type: String, trim: true },
    /**
     * Prerequisite text – shown in schema.org/coursePrerequisites.
     * e.g. "12th grade with Physics and Mathematics"
     */
    prerequisites: { type: String, trim: true },
  },
  { _id: false },
);

/**
 * Internal linking targets for programmatic SEO pages.
 * Enables pages like /study-computer-science-in-uk
 */
const InternalLinkingSchema = new Schema(
  {
    relatedBlogs: [{ type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" }],
    relatedCountries: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Country" },
    ],
  },
  { _id: false },
);

// ─────────────────────────────────────────────
// Course Schema
// ─────────────────────────────────────────────

const CourseSchema = new Schema(
  {
    // ── EXISTING FIELDS (untouched) ──────────────────────────────────

    title: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, index: true },

    topLabel: { type: String, trim: true },
    subtitle: { type: String, trim: true },

    duration: { type: String, required: true, trim: true },
    fees: { type: String, trim: true },
    scholarships: { type: String, trim: true },
    avgSalary: { type: String, trim: true },

    level: {
      type: String,
      trim: true,
      enum: ["Bachelor", "Master", "PhD", "Diploma"],
    },

    field: { type: String, trim: true },

    primaryUniversity: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "University",
    },

    salariesInCountries: { type: String, trim: true },

    bgImage: { url: String, public_id: String },

    overviewTitle: { type: String, trim: true },
    overviewDescription: { type: String, trim: true },

    keyHighlights: [{ type: String, trim: true }],

    entryRequirements: [EntryRequirementSchema],

    careerProspects: { type: String, trim: true },
    popularJobRoles: [{ type: String, trim: true }],
    salaryExpectations: { type: String, trim: true },

    topUniversities: [
      { type: mongoose.Schema.Types.ObjectId, ref: "University" },
    ],

    countries: [{ type: mongoose.Schema.Types.ObjectId, ref: "Country" }],

    featured: { type: Boolean, default: false },

    // ── SEO FIELDS (new – additive only) ────────────────────────────

    /**
     * Primary SEO metadata for the course detail page.
     * Example target URL: /courses/msc-computer-science
     *
     * focusKeyword      → e.g. "MSc Computer Science abroad"
     * secondaryKeywords → e.g. ["CS masters UK", "computer science fees Canada"]
     */
    seo: {
      metaTitle: { type: String, maxlength: 65, trim: true },
      metaDescription: { type: String, maxlength: 160, trim: true },
      canonicalUrl: { type: String, trim: true },
      focusKeyword: { type: String, trim: true },
      secondaryKeywords: [{ type: String, trim: true }],
      noIndex: { type: Boolean, default: false },
      socialMeta: { type: SocialMetaSchema, default: () => ({}) },
    },

    /**
     * Structured data hints for schema.org/Course JSON-LD.
     */
    structuredData: { type: StructuredDataSchema, default: () => ({}) },

    /**
     * Internal linking – related blogs and countries.
     * Countries are also in the existing `countries` array above
     * (that is the editorial list); `internalLinking.relatedCountries`
     * is the curated SEO cross-link subset.
     */
    internalLinking: { type: InternalLinkingSchema, default: () => ({}) },

    /**
     * FAQ items for the course page (renders as FAQPage JSON-LD).
     * e.g. "What are the entry requirements?", "What salary can I expect?"
     */
    faqs: [
      {
        question: { type: String, trim: true },
        answer: { type: String, trim: true },
        _id: false,
      },
    ],

    /**
     * Programmatic SEO combo-page slugs.
     * Pre-computed slugs for pages like /study-msc-cs-in-uk
     * Format: `study-{course-slug}-in-{country-slug}`
     */
    comboPageSlugs: [{ type: String, trim: true, index: true }],

    seoLastReviewedAt: { type: Date },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────
// Slug Generation (existing hook – untouched)
//
// BUGFIX: mongoose ^9.6.2 removed the next() callback parameter from
// pre middleware — see countries.js for the full explanation and the
// migration-guide link. Fixed here the same way: no `next` parameter,
// no next() calls, early-return replaces `return next()`.
// ─────────────────────────────────────────────

CourseSchema.pre("save", async function () {
  if (!this.isModified("title") && this.slug) return;

  const Course = mongoose.model("Course");

  const baseSlug = slugify(this.title, { lower: true, strict: true });

  let slug = baseSlug;
  let counter = 1;

  while (await Course.findOne({ slug, _id: { $ne: this._id } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  this.slug = slug;
});

// ─────────────────────────────────────────────
// Auto-fill SEO defaults before save
// ─────────────────────────────────────────────

CourseSchema.pre("save", function () {
  if (!this.seo?.metaTitle && this.title) {
    this.seo = this.seo || {};
    this.seo.metaTitle = `${this.title} Abroad – Fees, Top Universities & Scope | Khizar Overseas`;
  }

  if (!this.seo?.metaDescription && this.overviewDescription) {
    this.seo.metaDescription = this.overviewDescription.slice(0, 155);
  }
});

// ─────────────────────────────────────────────
// Indexes (existing + new)
// ─────────────────────────────────────────────

// Existing full-text index (untouched)
CourseSchema.index(
  {
    title: "text",
    subtitle: "text",
    field: "text",
    overviewDescription: "text",
    popularJobRoles: "text",
  },
  {
    weights: {
      title: 10,
      field: 6,
      subtitle: 4,
      popularJobRoles: 3,
      overviewDescription: 2,
    },
  },
);

CourseSchema.index({ primaryUniversity: 1 });
CourseSchema.index({ topUniversities: 1 });

// New SEO indexes
CourseSchema.index({ "seo.noIndex": 1 });
CourseSchema.index({ "internalLinking.relatedBlogs": 1 });
CourseSchema.index({ countries: 1, level: 1 }); // for /courses?country=uk&level=Master pages

module.exports = mongoose.model("Course", CourseSchema);
