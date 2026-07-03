/** ⚠️  AUTO-SYNCED FILE — DO NOT EDIT DIRECTLY
 * Source of truth: config/models/countries.js (Phase 3 schema sync)
 * Edit that file instead, then run: node scripts/syncSchemas.js --apply
 * (config repo: overseasbackend) */

const mongoose = require("mongoose");
const { Schema } = mongoose;
const slugify = require("slugify");

// ─────────────────────────────────────────────
// Sub Schemas (existing – untouched)
// ─────────────────────────────────────────────

const WhyStudyCardSchema = new Schema(
  {
    title: { type: String, trim: true },
    description: { type: String, required: true, trim: true },
  },
  { _id: false },
);

// ─────────────────────────────────────────────
// NEW ▸ SEO Sub-Schemas
// ─────────────────────────────────────────────

/**
 * Open Graph / Twitter card metadata for social sharing.
 * Used by frontend to populate <meta og:*> and <meta twitter:*> tags.
 */
const SocialMetaSchema = new Schema(
  {
    ogTitle: { type: String, maxlength: 95, trim: true },
    ogDescription: { type: String, maxlength: 200, trim: true },
    ogImage: {
      url: String,
      public_id: String,
    },
    twitterTitle: { type: String, maxlength: 70, trim: true },
    twitterDescription: { type: String, maxlength: 200, trim: true },
  },
  { _id: false },
);

/**
 * Structured data (JSON-LD) hint fields.
 * The backend/frontend can use these to emit <script type="application/ld+json">
 * for richer Google rich-results (e.g. EducationalOrganization, Place schema).
 */
const StructuredDataSchema = new Schema(
  {
    /** ISO 3166-1 alpha-2 code, e.g. "GB", "CA". Used in Place schema. */
    isoCode: { type: String, uppercase: true, trim: true, maxlength: 3 },
    /** Official currency code, e.g. "GBP". */
    currency: { type: String, trim: true, maxlength: 5 },
    /** Official language(s), e.g. ["English"]. */
    languages: [{ type: String, trim: true }],
    /** Average cost of living per month in USD for student budget pages. */
    costOfLiving: { type: String, trim: true },
  },
  { _id: false },
);

/**
 * Internal linking targets for programmatic SEO.
 * When a Country page is rendered, these refs allow automatic
 * "Related Courses" and "Related Blogs" sections without extra queries.
 */
const InternalLinkingSchema = new Schema(
  {
    relatedCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],
    relatedBlogs: [{ type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" }],
  },
  { _id: false },
);

// ─────────────────────────────────────────────
// Country Schema
// ─────────────────────────────────────────────

const CountrySchema = new Schema(
  {
    // ── EXISTING FIELDS (untouched) ──────────────────────────────────

    name: { type: String, required: true, trim: true, unique: true },

    slug: { type: String, unique: true, index: true },

    continent: { type: String, required: true, trim: true },
    capital: { type: String, required: true, trim: true },

    visaSuccessRate: { type: Number, required: true, min: 0, max: 100 },
    visaSuccessRateEstimated: { type: Boolean, default: false },

    popularCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],
    careerOpportunities: [{ type: String, trim: true }],
    scholarships: [{ type: String, trim: true }],
    eligibilityRequirements: [{ type: String, trim: true }],
    topUniversities: [
      { type: mongoose.Schema.Types.ObjectId, ref: "University" },
    ],

    whyStudyCards: [WhyStudyCardSchema],

    flagImage: { url: String, public_id: String },
    heroImage: { url: String, public_id: String },

    featured: { type: Boolean, default: false },

    // ── SEO FIELDS (new – additive only) ────────────────────────────

    /**
     * Primary SEO fields for the country landing page.
     * metaTitle    → <title> tag           (keep ≤ 60 chars)
     * metaDescription → <meta description> (keep ≤ 155 chars)
     * canonicalUrl → explicit canonical if the page has alternate URLs
     * focusKeyword → primary keyword this page targets (editorial guide)
     * secondaryKeywords → LSI / long-tail variants for content writers
     * noIndex → set true to block indexing (e.g. stub/draft pages)
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
     * Structured data hints for JSON-LD generation.
     */
    structuredData: { type: StructuredDataSchema, default: () => ({}) },

    /**
     * Internal linking – pre-resolved refs for programmatic SEO pages.
     * Example usage: /study-in-uk/computer-science  →  Country + Course combo page
     */
    internalLinking: { type: InternalLinkingSchema, default: () => ({}) },

    /**
     * FAQ items rendered on the country page.
     * Google can show these as rich results via FAQPage schema.
     */
    faqs: [
      {
        question: { type: String, trim: true },
        answer: { type: String, trim: true },
        _id: false,
      },
    ],

    /**
     * Last time this page's SEO metadata was intentionally reviewed/updated.
     * Useful for content audit tooling.
     */
    seoLastReviewedAt: { type: Date },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────
// Indexes (existing + new SEO indexes)
// ─────────────────────────────────────────────

CountrySchema.index({ continent: 1 });
CountrySchema.index({ featured: 1 });

// Existing full-text index (untouched)
CountrySchema.index(
  { name: "text", continent: "text", capital: "text", popularCourses: "text" },
  { weights: { name: 10, continent: 5, capital: 4, popularCourses: 6 } },
);

// New SEO indexes
CountrySchema.index({ "seo.noIndex": 1 });
CountrySchema.index({ "internalLinking.relatedBlogs": 1 });
CountrySchema.index({ "internalLinking.relatedCourses": 1 });

// ─────────────────────────────────────────────
// Hooks (existing slug hook – untouched)
// ─────────────────────────────────────────────

CountrySchema.pre("save", async function () {
  if (!this.isModified("name") && this.slug) return;

  const Country = mongoose.model("Country");

  const baseSlug = slugify(this.name, { lower: true, strict: true });

  let slug = baseSlug;
  let counter = 1;

  while (await Country.findOne({ slug, _id: { $ne: this._id } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  this.slug = slug;
});

// ─────────────────────────────────────────────
// Auto-fill SEO defaults before save
// ─────────────────────────────────────────────

CountrySchema.pre("save", function (next) {
  // Auto-generate metaTitle if not provided
  if (!this.seo?.metaTitle && this.name) {
    this.seo = this.seo || {};
    this.seo.metaTitle = `Study in ${this.name} | Khizar Overseas`;
  }

  // Auto-generate metaDescription from whyStudyCards[0] if available
  if (!this.seo?.metaDescription && this.whyStudyCards?.length) {
    this.seo.metaDescription = this.whyStudyCards[0].description.slice(0, 155);
  }

  next();
});

module.exports = mongoose.model("Country", CountrySchema);
