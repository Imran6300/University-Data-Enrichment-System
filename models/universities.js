/** ⚠️  AUTO-SYNCED FILE — DO NOT EDIT DIRECTLY
 * Source of truth: config/models/universities.js (Phase 3 schema sync)
 * Edit that file instead, then run: node scripts/syncSchemas.js --apply
 * (config repo: overseasbackend) */

const mongoose = require("mongoose");
const { Schema } = mongoose;
const slugify = require("slugify");

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
 * Structured data hints for JSON-LD generation.
 * Maps to schema.org/CollegeOrUniversity
 */
const StructuredDataSchema = new Schema(
  {
    /** schema.org type to emit, default CollegeOrUniversity */
    schemaType: { type: String, default: "CollegeOrUniversity", trim: true },
    foundingYear: { type: Number },
    /** Average annual tuition in USD (numeric for schema.org/PriceSpecification) */
    tuitionUSD: { type: Number },
    addressLocality: { type: String, trim: true },
    addressCountry: { type: String, trim: true },
    /** Official phone or contact point */
    telephone: { type: String, trim: true },
    sameAs: [{ type: String, trim: true }], // Wikipedia, Wikidata, RankingURL etc.
  },
  { _id: false },
);

/**
 * Internal linking targets.
 * Used to auto-build "Courses at this University", "Related Blogs" sections.
 */
const InternalLinkingSchema = new Schema(
  {
    relatedBlogs: [{ type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" }],
  },
  { _id: false },
);

// ─────────────────────────────────────────────
// University Schema
// ─────────────────────────────────────────────

const UniversitySchema = new Schema(
  {
    // ── EXISTING FIELDS (untouched) ──────────────────────────────────

    name: { type: String, required: true, trim: true, unique: true },

    slug: { type: String, unique: true },

    country: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Country",
      required: true,
      index: true,
    },

    flag: { type: String, trim: true },
    city: { type: String, trim: true },
    website: { type: String, trim: true },

    featured: { type: Boolean, default: false },
    partnered: { type: Boolean, default: false },
    isEnriched: { type: Boolean, default: false, index: true },

    qsRanking: { type: Number },
    acceptanceRate: { type: Number },
    totalStudents: { type: String },
    tuitionFee: { type: String },
    studentsPlaced: { type: Number },

    description: { type: String, maxlength: 5000 },

    courses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],

    programs: [
      {
        category: { type: String, required: true, trim: true },
        level: { type: String, required: true, trim: true },
      },
    ],

    intakes: [{ type: String, trim: true }],
    admissionRequirements: [{ type: String, trim: true }],
    similarUniversities: [{ type: String, trim: true }],

    logo: { url: String, public_id: String },
    images: [{ url: String, public_id: String }],

    enrichment: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "partial", "failed"],
        default: "pending",
        index: true,
      },
      confidenceScore: { type: Number, default: 0 },
      validated: { type: Boolean, default: false },
      sourceUrls: [{ type: String }],
      lastEnrichedAt: { type: Date },
      crawlAttempts: { type: Number, default: 0 },
      failedReason: { type: String },
    },

    // ── SEO FIELDS (new – additive only) ────────────────────────────

    /**
     * Primary SEO metadata for the university detail page.
     * Example target URL: /universities/university-of-edinburgh
     *
     * focusKeyword      → e.g. "University of Edinburgh admission"
     * secondaryKeywords → e.g. ["Edinburgh tuition fees", "study in Scotland"]
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
     * Structured data hints for CollegeOrUniversity JSON-LD.
     */
    structuredData: { type: StructuredDataSchema, default: () => ({}) },

    /**
     * Internal linking – related blog posts for this university.
     * Courses are already linked via `courses` array above.
     */
    internalLinking: { type: InternalLinkingSchema, default: () => ({}) },

    /**
     * FAQ items for the university page (renders as FAQPage JSON-LD).
     * e.g. "What is the acceptance rate?", "When are the intakes?"
     */
    faqs: [
      {
        question: { type: String, trim: true },
        answer: { type: String, trim: true },
        _id: false,
      },
    ],

    /**
     * Programmatic SEO combo-page support.
     * Enables auto-generation of pages like /study-cs-in-edinburgh
     * by cross-referencing this university's courses + country.
     *
     * comboPageSlugs are pre-computed slugs stored so the sitemap
     * generator can enumerate them without a join.
     * e.g. ["study-computer-science-university-of-edinburgh"]
     */
    comboPageSlugs: [{ type: String, trim: true, index: true }],

    seoLastReviewedAt: { type: Date },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────
// Indexes (existing + new)
// ─────────────────────────────────────────────

UniversitySchema.index({ "programs.category": 1 });
UniversitySchema.index({ "programs.category": 1, "programs.level": 1 });

UniversitySchema.index(
  { name: "text", city: "text", description: "text" },
  { weights: { name: 10, city: 4, description: 2 } },
);

UniversitySchema.index({ country: 1 });
UniversitySchema.index({ qsRanking: 1 });
UniversitySchema.index({ createdAt: -1 });
UniversitySchema.index({ featured: 1 });
UniversitySchema.index({ partnered: 1 });

// New SEO indexes
UniversitySchema.index({ "seo.noIndex": 1 });
UniversitySchema.index({ comboPageSlugs: 1 });
UniversitySchema.index({ "internalLinking.relatedBlogs": 1 });

// ─────────────────────────────────────────────
// Hooks (existing slug hook – untouched)
// ─────────────────────────────────────────────

UniversitySchema.pre("save", async function (next) {
  if (!this.isModified("name") && this.slug) return next();

  const University = mongoose.model("University");

  const baseSlug = slugify(this.name, { lower: true, strict: true });

  let slug = baseSlug;
  let counter = 1;

  while (await University.findOne({ slug, _id: { $ne: this._id } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  this.slug = slug;
  next();
});

// ─────────────────────────────────────────────
// Auto-fill SEO defaults before save
// ─────────────────────────────────────────────

UniversitySchema.pre("save", function (next) {
  if (!this.seo?.metaTitle && this.name) {
    this.seo = this.seo || {};
    this.seo.metaTitle = `${this.name} – Admission, Fees & Courses | Khizar Overseas`;
  }

  if (!this.seo?.metaDescription && this.description) {
    this.seo.metaDescription = this.description.slice(0, 155);
  }

  next();
});

module.exports = mongoose.model("University", UniversitySchema);
