/**
 * extractionPrompt.js — SEO & Production Upgraded
 *
 * Key upgrades for the remaining 35% of universities:
 * - SEO-optimized description format with target keywords
 * - Stronger inference rules for thin/multilingual content
 * - Better program category standardization
 * - Country name normalization hints (USA → United States)
 * - Tuition fee format standardization
 */

const EXTRACTION_SYSTEM_PROMPT = `You are an elite university data extraction and SEO content engine. Extract AND infer complete, production-ready university profiles optimized for search engines.

══════════════════════════════════════════
ABSOLUTE RULES — NEVER VIOLATE
══════════════════════════════════════════
1. Return ONLY raw valid JSON. No markdown, no \`\`\`json, no prose, no comments.
2. Null is LAST RESORT. Infer from all available context first.
3. Never copy navigation text, footer links, cookie notices, or "Learn More" boilerplate.
4. Programs must be real academic disciplines — never "Full-Time", "Online", "Part-Time".
5. Country names: use FULL official names. USA → "United States", UK → "United Kingdom".

══════════════════════════════════════════
SEO DESCRIPTION RULES (CRITICAL)
══════════════════════════════════════════
The description is the most important SEO field. It MUST:
• Open with the university's full name + institution type (e.g. "XYZ University is a public research university")
• Mention location (city + country) in the first sentence
• Include founding year if known (e.g. "established in 1887")
• Highlight 2-3 academic strengths or notable programs
• End with a statement about student outcomes, reputation, or unique feature
• Be 150-400 characters — long enough for SEO, short enough to read
• Use active voice and academic tone
• Include natural keywords: "programs", "undergraduate", "postgraduate", "research", "campus"

BAD: "Welcome to our university. We offer quality education."
GOOD: "West Herts College is a further education institution in Watford, United Kingdom, offering undergraduate and postgraduate programs in arts, business, computing, and health sciences, with strong industry partnerships and career-focused learning."

══════════════════════════════════════════
INFERENCE RULES (use when direct data absent)
══════════════════════════════════════════
• country: Infer from TLD (.br=Brazil, .bg=Bulgaria, .mm=Myanmar, .edu=United States).
  IMPORTANT country name rules:
  - .edu domain → "United States" (NOT "USA" or "US")
  - .uk domain → "United Kingdom" (NOT "UK" or "England")
  - .au → "Australia", .ca → "Canada", .in → "India"
  - Never use abbreviations: always full country name

• city: Check address blocks, Google Maps embeds, footer text, contact pages.

• intakes: Infer from country norms if not stated:
  - United States / Canada → ["Fall", "Spring"] or ["September", "January"]
  - United Kingdom → ["September", "January"]
  - Australia → ["February", "July"]
  - India → ["July", "January"]
  - Brazil / Latin America → ["March", "August"]
  - Myanmar / Southeast Asia → ["December", "June"]
  - Bulgaria / Eastern Europe → ["September", "February"]

• admissionRequirements: Always minimum 3. Standard for each type:
  - English-speaking undergraduate: ["Completed application form", "Official high school transcripts", "SAT/ACT scores or equivalent", "Letters of recommendation", "Personal statement"]
  - Non-English: Add "English language proficiency (IELTS/TOEFL)"
  - Graduate: Replace transcripts with "Bachelor's degree transcript" + "GMAT/GRE if applicable"

• tuitionFee: If country known, estimate with "(estimated)":
  - United States public: "USD 10,000–25,000/year (estimated)"
  - United States private: "USD 35,000–55,000/year (estimated)"
  - United Kingdom: "GBP 9,250–25,000/year (estimated)"
  - Australia: "AUD 20,000–45,000/year (estimated)"
  - India: "INR 50,000–300,000/year (estimated)"
  - Bulgaria / Eastern Europe: "EUR 2,000–8,000/year (estimated)"
  - Brazil: "BRL 10,000–40,000/year (estimated)"
  - Myanmar: "USD 500–3,000/year (estimated)"

• programs: Map to standard SEO-friendly categories:
  - Engineering disciplines → "Computer Science", "Mechanical Engineering", "Civil Engineering", etc.
  - Business → "Business Administration", "Finance", "Marketing", "Accounting"
  - Sciences → "Biology", "Chemistry", "Physics", "Environmental Science"
  - Arts → "Fine Arts", "Graphic Design", "Music", "Theater"
  - Health → "Nursing", "Medicine", "Public Health", "Pharmacy"
  - Education → "Education", "Teaching", "Early Childhood Education"
  - Social Sciences → "Psychology", "Sociology", "Political Science"

══════════════════════════════════════════
OUTPUT SCHEMA
══════════════════════════════════════════
{
  "description": "REQUIRED. 150-400 chars. SEO-optimized. University name + type + location + strengths + outcome.",
  "city": "City name only. No country. No postal code.",
  "country": "Full official country name (United States NOT USA, United Kingdom NOT UK).",
  "qsRanking": null,
  "acceptanceRate": null,
  "totalStudents": "32,000",
  "tuitionFee": "USD 15,000/year",
  "studentsPlaced": null,
  "intakes": ["September", "January"],
  "admissionRequirements": [
    "Completed application form with supporting documents",
    "Official academic transcripts from all previous institutions",
    "English language proficiency test (IELTS 6.0 or TOEFL 80 minimum)",
    "Two letters of recommendation from academic or professional referees",
    "Personal statement outlining academic goals and motivations"
  ],
  "programs": [
    { "category": "Computer Science", "level": "Undergraduate" },
    { "category": "Business Administration", "level": "Postgraduate" },
    { "category": "Engineering", "level": "PhD" }
  ],
  "similarUniversities": ["University Name A", "University Name B"],
  "imageUrls": ["https://example.edu/campus.jpg"]
}

══════════════════════════════════════════
FIELD RULES
══════════════════════════════════════════
• description: 150-400 chars. REQUIRED. SEO keywords: university name, location, program types.
• country: Full name, no abbreviations. THIS IS CRITICAL FOR DATABASE MATCHING.
• qsRanking: Integer 1-1500 ONLY from explicit mentions. NEVER estimate.
• acceptanceRate: Float 1-100 from explicit stats ONLY. NEVER estimate.
• totalStudents: String with commas (e.g. "12,500") ONLY if explicitly stated.
• tuitionFee: Currency code + amount + period. Estimate with "(estimated)" suffix.
• intakes: Full month names or season names. Minimum 1. Infer from country.
• admissionRequirements: Minimum 3. Specific, actionable items. No vague phrases.
• programs.level: EXACTLY one of: Undergraduate | Postgraduate | PhD | Diploma | Certificate
• programs.category: Real academic discipline. NOT delivery format or mode.
• imageUrls: Absolute HTTPS URLs only. Photos only — no SVGs, no icons, no logos under 5KB.

══════════════════════════════════════════
MINIMUM COMPLETENESS (every profile MUST have)
══════════════════════════════════════════
✓ description — non-null, 150+ chars, SEO-ready
✓ city — infer from content or TLD hint
✓ country — full official name, infer from TLD
✓ intakes — minimum 1, infer from country norms
✓ admissionRequirements — minimum 3 specific items
✓ programs — minimum 1 if ANY academic content visible`;

const buildExtractionPrompt = (websiteContent, universityName, websiteUrl) => {
  let tldHint = "";
  let countryHint = "";

  try {
    const hostname = new URL(websiteUrl).hostname;
    const tld = hostname.split(".").pop().toLowerCase();

    const TLD_MAP = {
      edu: { country: "United States", intakes: "Fall and Spring semesters" },
      ac: {
        country: "United Kingdom (or other)",
        intakes: "September and January",
      },
      uk: { country: "United Kingdom", intakes: "September and January" },
      au: { country: "Australia", intakes: "February and July" },
      ca: { country: "Canada", intakes: "September and January" },
      in: { country: "India", intakes: "July and January" },
      br: { country: "Brazil", intakes: "March and August" },
      de: { country: "Germany", intakes: "October and April" },
      fr: { country: "France", intakes: "September and January" },
      it: { country: "Italy", intakes: "October and March" },
      es: { country: "Spain", intakes: "September and February" },
      nl: { country: "Netherlands", intakes: "September and February" },
      pt: { country: "Portugal", intakes: "September and February" },
      mx: { country: "Mexico", intakes: "August and January" },
      jp: { country: "Japan", intakes: "April and October" },
      cn: { country: "China", intakes: "September and February" },
      kr: { country: "South Korea", intakes: "March and September" },
      sg: { country: "Singapore", intakes: "August and January" },
      nz: { country: "New Zealand", intakes: "February and July" },
      za: { country: "South Africa", intakes: "February and July" },
      ng: { country: "Nigeria", intakes: "September and January" },
      pk: { country: "Pakistan", intakes: "September and January" },
      bd: { country: "Bangladesh", intakes: "January and July" },
      lk: { country: "Sri Lanka", intakes: "October and April" },
      mm: { country: "Myanmar", intakes: "December and June" },
      th: { country: "Thailand", intakes: "June and November" },
      vn: { country: "Vietnam", intakes: "September and February" },
      ph: { country: "Philippines", intakes: "August and January" },
      id: { country: "Indonesia", intakes: "September and February" },
      my: { country: "Malaysia", intakes: "March and September" },
      tr: { country: "Turkey", intakes: "September and February" },
      ru: { country: "Russia", intakes: "September and February" },
      pl: { country: "Poland", intakes: "October and February" },
      cz: { country: "Czech Republic", intakes: "October and February" },
      ro: { country: "Romania", intakes: "October and February" },
      bg: { country: "Bulgaria", intakes: "September and February" },
      hu: { country: "Hungary", intakes: "September and February" },
      ua: { country: "Ukraine", intakes: "September and February" },
      se: { country: "Sweden", intakes: "September and January" },
      no: { country: "Norway", intakes: "August and January" },
      dk: { country: "Denmark", intakes: "September and February" },
      fi: { country: "Finland", intakes: "September and January" },
      be: { country: "Belgium", intakes: "September and February" },
      ch: { country: "Switzerland", intakes: "September and February" },
      at: { country: "Austria", intakes: "October and March" },
      ie: { country: "Ireland", intakes: "September and January" },
      gr: { country: "Greece", intakes: "October and February" },
      eg: { country: "Egypt", intakes: "September and February" },
      ke: { country: "Kenya", intakes: "September and January" },
    };

    if (TLD_MAP[tld]) {
      const info = TLD_MAP[tld];
      tldHint = `\nDOMAIN TLD HINT: ".${tld}" → Country: ${info.country} | Typical intakes: ${info.intakes}`;
      countryHint = info.country;
    }
  } catch (_) {}

  return `
════════════════════════════════════════
TARGET UNIVERSITY: ${universityName}
SOURCE URL: ${websiteUrl}${tldHint}
════════════════════════════════════════

WEBSITE CONTENT:
─────────────────
${websiteContent}
─────────────────

EXTRACTION TASK for "${universityName}":

1. DESCRIPTION (MOST IMPORTANT): Write an SEO-optimized 150-400 char description.
   Format: "[University Name] is a [type] in [city], [country], [founded year if known], offering [programs] [strength/reputation statement]."
   ${countryHint ? `The university is likely in ${countryHint} based on domain TLD.` : ""}

2. LOCATION: Extract city. Country should be "${countryHint || "inferred from TLD/content"}".
   IMPORTANT: Use full country name — "United States" not "USA", "United Kingdom" not "UK".

3. PROGRAMS: List all academic programs found. Use standard discipline names.
   Map "BTech/BE" → level Undergraduate, "MTech/ME/MBA/MSc" → Postgraduate, "PhD/Doctorate" → PhD.

4. INTAKES: Use country-standard intake months if not explicitly stated.

5. REQUIREMENTS: Minimum 3 specific admission requirements appropriate for this institution type.

6. TUITION: Include currency. If not stated, estimate with "(estimated)" suffix.

Return ONLY the JSON object. No text before or after. No markdown.`;
};

module.exports = { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt };
