const mongoose = require("mongoose");
const { Schema } = mongoose;
const slugify = require("slugify");

// Why Study Cards Sub Schema
const WhyStudyCardSchema = new Schema(
  {
    title: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false },
);

// Country Schema
const CountrySchema = new Schema(
  {
    // Basic Info
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },

    slug: {
      type: String,
      unique: true,
      index: true,
    },

    continent: {
      type: String,
      required: true,
      trim: true,
    },

    capital: {
      type: String,
      required: true,
      trim: true,
    },

    // Statistics
    visaSuccessRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },

    visaSuccessRateEstimated: {
      type: Boolean,
      default: false,
    },

    // Academic & Study Info
    popularCourses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
      },
    ],

    careerOpportunities: [
      {
        type: String,
        trim: true,
      },
    ],

    scholarships: [
      {
        type: String,
        trim: true,
      },
    ],

    eligibilityRequirements: [
      {
        type: String,
        trim: true,
      },
    ],

    topUniversities: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "University",
      },
    ],

    whyStudyCards: [WhyStudyCardSchema],

    // Cloudinary Images
    flagImage: {
      url: String,
      public_id: String,
    },

    heroImage: {
      url: String,
      public_id: String,
    },

    // Flags
    featured: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Indexing for Filtering & SEO
CountrySchema.index({ continent: 1 });
CountrySchema.index({ featured: 1 });
CountrySchema.index(
  {
    name: "text",
    continent: "text",
    capital: "text",
    popularCourses: "text",
  },
  {
    weights: {
      name: 10,
      continent: 5,
      capital: 4,
      popularCourses: 6,
    },
  },
);

// Auto Slug Generator (Like University)
CountrySchema.pre("save", async function () {
  if (!this.isModified("name") && this.slug) return;

  const Country = mongoose.model("Country");

  const baseSlug = slugify(this.name, {
    lower: true,
    strict: true,
  });

  let slug = baseSlug;
  let counter = 1;

  while (
    await Country.findOne({
      slug,
      _id: { $ne: this._id },
    })
  ) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  this.slug = slug;
});

module.exports = mongoose.model("Country", CountrySchema);
