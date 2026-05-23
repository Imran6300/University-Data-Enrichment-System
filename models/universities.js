const mongoose = require("mongoose");
const { Schema } = mongoose;
const slugify = require("slugify");

const UniversitySchema = new Schema(
  {
    // ===============================
    // Basic Info
    // ===============================
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },

    slug: {
      type: String,
      unique: true,
    },

    country: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Country",
      required: true,
      index: true,
    },

    flag: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    website: {
      type: String,
      trim: true,
    },

    // ===============================
    // Flags
    // ===============================
    featured: {
      type: Boolean,
      default: false,
    },

    partnered: {
      type: Boolean,
      default: false,
    },

    isEnriched: {
      type: Boolean,
      default: false,
      index: true, // 🔥 makes query fast
    },

    // ===============================
    // Statistics
    // ===============================
    qsRanking: {
      type: Number,
    },

    acceptanceRate: {
      type: Number,
    },

    totalStudents: {
      type: String,
    },

    tuitionFee: {
      type: String,
    },

    studentsPlaced: {
      type: Number,
    },

    // ===============================
    // Academic Details
    // ===============================
    description: {
      type: String,
      maxlength: 5000,
    },

    courses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
      },
    ],

    programs: [
      {
        category: {
          type: String,
          required: true,
          trim: true,
        },
        level: {
          type: String,
          required: true,
          trim: true,
        },
      },
    ],

    intakes: [
      {
        type: String,
        trim: true,
      },
    ],

    admissionRequirements: [
      {
        type: String,
        trim: true,
      },
    ],

    similarUniversities: [
      {
        type: String,
        trim: true,
      },
    ],

    // ===============================
    // Cloudinary Images
    // ===============================
    logo: {
      url: String,
      public_id: String,
    },

    images: [
      {
        url: String,
        public_id: String,
      },
    ],

    // ===============================
    // Enrichment Metadata
    // ===============================

    enrichment: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "partial", "failed"],
        default: "pending",
        index: true,
      },

      confidenceScore: {
        type: Number,
        default: 0,
      },

      validated: {
        type: Boolean,
        default: false,
      },

      sourceUrls: [
        {
          type: String,
        },
      ],

      lastEnrichedAt: {
        type: Date,
      },

      crawlAttempts: {
        type: Number,
        default: 0,
      },

      failedReason: {
        type: String,
      },
    },
  },
  { timestamps: true },
);

UniversitySchema.index({
  "programs.category": 1,
});

UniversitySchema.index(
  {
    name: "text",
    city: "text",
    description: "text",
  },
  {
    weights: {
      name: 10,
      city: 4,
      description: 2,
    },
  },
);

UniversitySchema.pre("save", async function (next) {
  if (!this.isModified("name") && this.slug) return next();

  const University = mongoose.model("University");

  const baseSlug = slugify(this.name, {
    lower: true,
    strict: true,
  });

  let slug = baseSlug;
  let counter = 1;

  // Exclude current document when checking
  while (
    await University.findOne({
      slug,
      _id: { $ne: this._id },
    })
  ) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  this.slug = slug;

  next();
});

UniversitySchema.index({ country: 1 });
UniversitySchema.index({ qsRanking: 1 });
UniversitySchema.index({ createdAt: -1 });
UniversitySchema.index({ featured: 1 });
UniversitySchema.index({ partnered: 1 });

UniversitySchema.index({
  "programs.category": 1,
  "programs.level": 1,
});

module.exports = mongoose.model("University", UniversitySchema);
