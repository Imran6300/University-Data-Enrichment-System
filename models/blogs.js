/** ⚠️  AUTO-SYNCED FILE — DO NOT EDIT DIRECTLY
 * Source of truth: config/models/blogs.js (Phase 3 schema sync)
 * Edit that file instead, then run: node scripts/syncSchemas.js --apply
 * (config repo: overseasbackend) */

const mongoose = require("mongoose");
const slugify = require("slugify");

// ─────────────────────────────────────────────
// NEW ▸ SEO Sub-Schemas
// ─────────────────────────────────────────────

const SocialMetaSchema = new mongoose.Schema(
  {
    ogTitle: { type: String, maxlength: 95, trim: true },
    ogDescription: { type: String, maxlength: 200, trim: true },
    ogImage: { url: String, public_id: String },
    twitterTitle: { type: String, maxlength: 70, trim: true },
    twitterDescription: { type: String, maxlength: 200, trim: true },
  },
  { _id: false },
);

// ─────────────────────────────────────────────
// Blog Post Schema
// ─────────────────────────────────────────────

const BlogPostSchema = new mongoose.Schema(
  {
    // ── EXISTING FIELDS (untouched) ──────────────────────────────────

    title: { type: String, required: true, trim: true, maxlength: 120 },

    slug: {
      type: String,
      unique: true,
      index: true,
      required: true,
      lowercase: true,
      trim: true,
    },

    metaTitle: { type: String, maxlength: 85 },
    metaDescription: { type: String, maxlength: 250 },

    excerpt: String,

    content: { type: String, required: true },

    coverImage: { url: String, public_id: String },
    altText: String,

    status: {
      type: String,
      enum: ["Draft", "Scheduled", "Published"],
      default: "Draft",
    },

    publishDate: Date,

    featured: { type: Boolean, default: false },

    focusCountry: String,
    focusUniversity: String,
    focusCourseLevel: String,

    tags: [String],

    estimatedReadTime: String,

    views: { type: Number, default: 0 },

    author: {
      name: { type: String, default: "Khizar Overseas" },
      image: String,
    },

    // ── SEO FIELDS (new – additive only) ────────────────────────────

    /**
     * Typed ObjectId relationships replacing the loose String fields above.
     * The existing `focusCountry`, `focusUniversity`, `focusCourseLevel`
     * strings are kept for backward compat; these refs are the SEO layer.
     *
     * Usage in frontend:
     *   - Auto-populate "Related Countries" sidebar
     *   - Build breadcrumb: Home → Countries → UK → Blog
     *   - Emit BreadcrumbList JSON-LD
     */
    relatedCountries: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Country" },
    ],
    relatedUniversities: [
      { type: mongoose.Schema.Types.ObjectId, ref: "University" },
    ],
    relatedCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],

    /**
     * canonicalUrl – set if this post has a canonical that differs from
     * the default URL (e.g. post was syndicated or re-published).
     */
    canonicalUrl: { type: String, trim: true },

    /**
     * focusKeyword – primary keyword this article is optimized for.
     * Used by the editorial team; not exposed publicly.
     * e.g. "study in Canada for Indian students"
     */
    focusKeyword: { type: String, trim: true },

    /**
     * secondaryKeywords – LSI / supporting keywords.
     * e.g. ["Canada student visa", "PR after masters Canada"]
     */
    secondaryKeywords: [{ type: String, trim: true }],

    /**
     * noIndex – set true to prevent this post from being indexed
     * (e.g. thin content, duplicate, internal-only posts).
     */
    noIndex: { type: Boolean, default: false },

    /**
     * Social metadata (Open Graph / Twitter Card).
     * Falls back to coverImage + metaTitle/metaDescription if not set.
     */
    socialMeta: { type: SocialMetaSchema, default: () => ({}) },

    /**
     * Article-level structured data hints for JSON-LD (schema.org/Article).
     * wordCount – helps Google assess content quality signals.
     * articleSection – e.g. "Visa Guides", "Country Guides", "Scholarship News"
     * speakable – CSS selectors for Google Assistant speakable feature
     */
    structuredData: {
      wordCount: { type: Number },
      articleSection: { type: String, trim: true },
      speakable: [{ type: String, trim: true }],
    },

    /**
     * FAQ items embedded in the blog post.
     * Rendered as FAQPage JSON-LD for rich results.
     * Only populate if the article explicitly has a Q&A section.
     */
    faqs: [
      {
        question: { type: String, trim: true },
        answer: { type: String, trim: true },
        _id: false,
      },
    ],

    /**
     * Breadcrumb path for JSON-LD BreadcrumbList.
     * Auto-generated from relatedCountries/relatedCourses by the API,
     * but can be overridden here for custom hierarchies.
     * e.g. [{ name: "Home", url: "/" }, { name: "UK", url: "/countries/uk" }]
     */
    breadcrumbs: [
      {
        name: { type: String, trim: true },
        url: { type: String, trim: true },
        _id: false,
      },
    ],

    /**
     * Internal links to other blog posts (for content clusters / pillar-spoke model).
     * The pillar post links out to spoke posts and vice versa.
     */
    relatedPosts: [{ type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" }],

    /**
     * Content cluster role.
     * "pillar" = main hub page (e.g. "Complete Guide to Studying in the UK")
     * "spoke"  = supporting page (e.g. "UK Student Visa Requirements 2025")
     * null     = standalone post
     */
    clusterRole: {
      type: String,
      enum: ["pillar", "spoke", null],
      default: null,
    },

    /** If this is a spoke, link back to the pillar post. */
    pillarPost: { type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" },

    seoLastReviewedAt: { type: Date },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────
// Hooks (existing hook – untouched + new SEO auto-fill)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Hooks (existing hook – untouched + new SEO auto-fill)
//
// BUGFIX: mongoose ^9.6.2 removed the next() callback parameter from
// pre middleware — see countries.js for the full explanation and the
// migration-guide link. An async pre-validate hook now just throws on
// error (Mongoose treats a rejected promise the same way it used to
// treat next(err)) instead of calling next(err); the trailing next()
// on success is simply removed.
// ─────────────────────────────────────────────

BlogPostSchema.pre("validate", async function () {
  // ── Existing slug logic (untouched) ─────────────────────────────
  if (this.isModified("title") || !this.slug) {
    let baseSlug = slugify(this.title, {
      lower: true,
      strict: true,
      trim: true,
    });

    let slug = baseSlug;
    let counter = 1;

    while (true) {
      const existing = await mongoose.models.BlogPost.findOne({
        slug,
        _id: { $ne: this._id },
      });
      if (!existing) break;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    this.slug = slug;
  }

  if (!this.metaTitle) this.metaTitle = this.title;
  if (!this.metaDescription && this.excerpt)
    this.metaDescription = this.excerpt.slice(0, 155);
  if (!this.altText) this.altText = this.title;

  // ── New SEO auto-fill ────────────────────────────────────────────
  // Sync socialMeta fallbacks
  if (!this.socialMeta?.ogTitle)
    this.socialMeta = {
      ...this.socialMeta,
      ogTitle: this.metaTitle || this.title,
    };
  if (!this.socialMeta?.ogDescription)
    this.socialMeta = {
      ...this.socialMeta,
      ogDescription: this.metaDescription,
    };

  // Auto-compute word count for structured data
  if (this.content && !this.structuredData?.wordCount) {
    this.structuredData = {
      ...(this.structuredData || {}),
      wordCount: this.content.trim().split(/\s+/).length,
    };
  }
});

// ─────────────────────────────────────────────
// Indexes (existing + new)
// ─────────────────────────────────────────────

// Existing indexes (untouched)
BlogPostSchema.index({ status: 1, publishDate: -1 });
BlogPostSchema.index({ featured: 1 });
BlogPostSchema.index({ tags: 1 });
BlogPostSchema.index({ focusCountry: 1 });

// New SEO indexes
BlogPostSchema.index({ relatedCountries: 1 });
BlogPostSchema.index({ relatedUniversities: 1 });
BlogPostSchema.index({ relatedCourses: 1 });
BlogPostSchema.index({ noIndex: 1 });
BlogPostSchema.index({ clusterRole: 1 });
BlogPostSchema.index({ pillarPost: 1 });
BlogPostSchema.index({ relatedPosts: 1 });

module.exports =
  mongoose.models.BlogPost || mongoose.model("BlogPost", BlogPostSchema);
