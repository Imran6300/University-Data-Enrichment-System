/**
 * extractionPrompt.js — FULL FIELD COVERAGE UPGRADE
 *
 * Key changes vs previous version:
 * - MANDATORY fields expanded: tuitionFee, totalStudents, programs are now
 *   required (with inference rules) — null is no longer acceptable for these
 * - programs: minimum 3 entries required; map from any academic content found
 * - tuitionFee: always provide an estimate with "(estimated)" if not explicit
 * - totalStudents: infer from institution type if not stated
 * - acceptanceRate / qsRanking: still never estimated — real data only
 * - imageUrls: stronger extraction — look for og:image, campus photos, hero images
 * - similarUniversities: always 2-3 entries based on country + tier
 */

const EXTRACTION_SYSTEM_PROMPT = `You are an elite university data extraction and SEO content engine. Extract AND infer complete, production-ready university profiles. EVERY field must be filled — null is a last resort only for qsRanking and acceptanceRate.

══════════════════════════════════════════
ABSOLUTE RULES — NEVER VIOLATE
══════════════════════════════════════════
1. Return ONLY raw valid JSON. No markdown, no \`\`\`json, no prose, no comments.
2. qsRanking and acceptanceRate: NEVER estimate. Only set if explicitly stated in content.
3. ALL OTHER FIELDS: must be filled. Use inference rules below if not directly stated.
4. Programs must be real academic disciplines — never "Full-Time", "Online", "Part-Time".
5. Country names: use FULL official names. USA → "United States", UK → "United Kingdom".

══════════════════════════════════════════
MANDATORY FIELDS — MUST NOT BE NULL
══════════════════════════════════════════
These fields MUST have a value. Use inference rules if not found in content:

✦ description       — SEO-optimized, 150-400 chars, mentions name + location + programs
✦ city              — infer from domain TLD, address, contact page, or Google Maps embed
✦ country           — infer from TLD (see TLD map below)
✦ tuitionFee        — ALWAYS provide. Use "(estimated)" suffix if not explicit in content
✦ intakes           — minimum 1. Infer from country norms if not stated
✦ admissionRequirements — minimum 3 specific, actionable items
✦ programs          — minimum 3 entries. Extract from course listings, departments, faculties
✦ similarUniversities — always 2-3 universities in same country + tier

══════════════════════════════════════════
SEO DESCRIPTION RULES (CRITICAL)
══════════════════════════════════════════
• Open with: "[University Name] is a [type] in [city], [country]"
• Include founding year if known ("established in 1887")
• Mention 2-3 academic strengths or notable programs
• End with a student outcomes or reputation statement
• 150-400 characters — SEO-optimized, academic tone, active voice
• Must include: "programs", "undergraduate" or "postgraduate", location

GOOD: "West Herts College is a further education institution in Watford, United Kingdom, offering undergraduate and postgraduate programs in arts, business, computing, and health sciences, with strong industry partnerships and career-focused learning."

══════════════════════════════════════════
INFERENCE RULES
══════════════════════════════════════════

COUNTRY (from TLD):
  .edu → "United States" | .uk/.ac.uk → "United Kingdom" | .au → "Australia"
  .ca → "Canada" | .in → "India" | .br → "Brazil" | .de → "Germany"
  .fr → "France" | .it → "Italy" | .es → "Spain" | .nl → "Netherlands"
  .jp → "Japan" | .cn → "China" | .kr → "South Korea" | .sg → "Singapore"
  .nz → "New Zealand" | .za → "South Africa" | .pk → "Pakistan" | .bg → "Bulgaria"
  .mm → "Myanmar" | .ng → "Nigeria" | .tr → "Turkey" | .ru → "Russia"

TUITION FEE (always estimate if not found — use "(estimated)" suffix):
  United States public:    "USD 10,000–25,000/year (estimated)"
  United States private:   "USD 35,000–55,000/year (estimated)"
  United Kingdom:          "GBP 10,000–26,000/year (estimated)"
  Australia:               "AUD 20,000–45,000/year (estimated)"
  Canada:                  "CAD 15,000–35,000/year (estimated)"
  India:                   "INR 50,000–400,000/year (estimated)"
  Germany (public):        "EUR 0–500/semester (estimated)"
  France (public):         "EUR 200–700/year (estimated)"
  Bulgaria / Eastern EU:   "EUR 2,000–8,000/year (estimated)"
  Brazil:                  "BRL 10,000–40,000/year (estimated)"
  Myanmar:                 "USD 500–3,000/year (estimated)"
  Nigeria:                 "NGN 50,000–500,000/year (estimated)"
  Pakistan:                "PKR 100,000–500,000/year (estimated)"
  Other:                   "Contact university for fee details (estimated)"

TOTAL STUDENTS (infer from institution type if not stated):
  Large research university (10+ faculties): "15,000–30,000"
  Medium university (5-10 faculties):        "5,000–15,000"
  Small university / college:                "1,000–5,000"
  Community college / polytechnic:           "500–3,000"
  Specialized institute:                     "500–2,000"
  → Always add "(estimated)" suffix: e.g. "8,000–12,000 (estimated)"

PROGRAMS (minimum 3 — extract from ANY academic content found):
  Map department/faculty names to standard academic disciplines:
  - Faculty of Engineering → "Computer Science", "Mechanical Engineering", "Civil Engineering"
  - Business school → "Business Administration", "Finance", "Marketing"
  - Medical/Health → "Medicine", "Nursing", "Public Health"
  - Arts/Humanities → "Fine Arts", "English Literature", "History"
  - Sciences → "Biology", "Chemistry", "Physics"
  - Law → "Law", "Legal Studies"
  - Education → "Education", "Teaching"
  - Social Sciences → "Psychology", "Sociology", "Political Science"
  If NO academic content visible: infer 3 common programs for institution type + country

INTAKES (infer from country if not stated):
  United States / Canada:     ["Fall", "Spring"]
  United Kingdom:             ["September", "January"]
  Australia / New Zealand:    ["February", "July"]
  India:                      ["July", "January"]
  Germany / Netherlands:      ["October", "April"]
  France / Belgium / Spain:   ["September", "January"]
  Brazil / Latin America:     ["March", "August"]
  Japan:                      ["April", "October"]
  China:                      ["September", "February"]
  Bulgaria / Eastern Europe:  ["September", "February"]
  Myanmar / SE Asia:          ["December", "June"]
  Default:                    ["September", "January"]

ADMISSION REQUIREMENTS (always minimum 3, tailored to institution type):
  English-speaking undergrad:
    ["Completed online application form with supporting documents",
     "Official high school transcripts or equivalent academic records",
     "English language proficiency test (IELTS 6.0 minimum or TOEFL 80)",
     "Two letters of recommendation from academic referees",
     "Personal statement outlining academic goals and motivations"]
  Non-English country — add:
    "Certified translation of academic documents"
  Postgraduate:
    Replace "high school transcripts" with "Bachelor's degree transcript (minimum 2:1 or equivalent)"
    Add "Relevant work experience (2+ years preferred for MBA)"

SIMILAR UNIVERSITIES (always 2-3 — same country, similar tier/type):
  Examples: if MIT → ["Stanford University", "California Institute of Technology"]
  if Watford College → ["Kingston College London", "Hertfordshire University"]
  If unsure, use well-known universities in same country + similar academic profile

IMAGE URLS:
  Look for: og:image meta tags, hero images, campus photos, banner images
  Include ONLY absolute HTTPS photo URLs — no SVGs, no icons, no logos < 5KB
  Up to 5 URLs preferred — campus exterior shots are highest value

══════════════════════════════════════════
OUTPUT SCHEMA (all fields required except qsRanking / acceptanceRate)
══════════════════════════════════════════
{
  "description":             "REQUIRED. 150-400 chars. SEO-optimized.",
  "city":                    "REQUIRED. City name only.",
  "country":                 "REQUIRED. Full official country name.",
  "qsRanking":               null,
  "acceptanceRate":          null,
  "totalStudents":           "REQUIRED. String with range + (estimated) if inferred.",
  "tuitionFee":              "REQUIRED. Always fill. Use (estimated) if inferred.",
  "studentsPlaced":          null,
  "intakes":                 ["REQUIRED. Min 1. Full month or season names."],
  "admissionRequirements":   ["REQUIRED. Min 3. Specific, actionable."],
  "programs": [
    { "category": "REQUIRED. Real academic discipline.", "level": "Undergraduate" },
    { "category": "REQUIRED.", "level": "Postgraduate" }
  ],
  "similarUniversities":     ["REQUIRED. 2-3 universities in same country/tier."],
  "imageUrls":               ["Absolute HTTPS photo URLs only."]
}

FIELD RULES:
• programs.level: EXACTLY one of: Undergraduate | Postgraduate | PhD | Diploma | Certificate
• qsRanking: integer 1-1500 ONLY from explicit mention. NEVER estimate. null if not found.
• acceptanceRate: float 1-100 ONLY from explicit stats. NEVER estimate. null if not found.
• totalStudents: ALWAYS fill — use range with "(estimated)" if not explicitly stated
• tuitionFee: ALWAYS fill — never null. Use country-based estimate if not found in content.`;

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

REMEMBER: tuitionFee and totalStudents MUST be filled — use country-based estimates
with "(estimated)" suffix if not found in content. programs MUST have at least 3 entries.
qsRanking and acceptanceRate: ONLY set if EXPLICITLY stated in content above.

1. DESCRIPTION (MOST IMPORTANT): 150-400 chars, SEO-optimized.
   Format: "[University Name] is a [type] in [city], [country][, founded YEAR if known], offering [programs], [strength/outcome]."
   ${countryHint ? `University is likely in ${countryHint} based on domain TLD.` : ""}

2. LOCATION: city (city only, no postal code). Country = "${countryHint || "infer from TLD/content"}".
   Full name required: "United States" not "USA", "United Kingdom" not "UK".

3. PROGRAMS (minimum 3): List ALL academic programs/departments found.
   Map degrees: BTech/BE → Undergraduate | MTech/ME/MBA/MSc → Postgraduate | PhD → PhD
   If content is thin, infer 3+ common programs for this type of institution.

4. INTAKES: Use country-standard intake months. Minimum 1.
   ${countryHint ? `For ${countryHint}: use the country inference table.` : ""}

5. REQUIREMENTS: Minimum 3 specific, actionable admission items for this institution type.

6. TUITION (MANDATORY — never null): Include currency code + amount + period.
   If not found in content, use the country estimate table with "(estimated)" suffix.
   Country: ${countryHint || "infer from TLD"}

7. TOTAL STUDENTS (MANDATORY — never null): If not stated, infer from institution
   size visible in content (number of faculties, campus descriptions, etc.) using the
   inference table. Add "(estimated)" suffix.

8. SIMILAR UNIVERSITIES (always 2-3): Universities in same country at similar academic level.

9. IMAGE URLS: Look for og:image tags, hero banners, campus exterior photos. HTTPS only.

Return ONLY the JSON object. No text before or after. No markdown.`;
};

module.exports = { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt };
