/**
 * gscClient.js
 *
 * PHASE 7c: thin wrapper around the Google Search Console
 * "Search Analytics" API (searchanalytics.query), used to pull real
 * Pages/Queries performance data on a schedule instead of relying on
 * manual CSV exports.
 *
 * SETUP REQUIRED (one-time, not something this script can do for you):
 * 1. In Google Cloud Console, create/select a project, enable the
 *    "Search Console API".
 * 2. Create a Service Account, download its JSON key.
 * 3. In Search Console (search.google.com/search-console) → Settings →
 *    Users and permissions → add the service account's email
 *    (...@...iam.gserviceaccount.com) as a "Full" or "Restricted" user
 *    on the khizaroverseas.in property.
 * 4. Set env vars:
 *      GSC_SERVICE_ACCOUNT_KEY_PATH=/path/to/key.json   (or)
 *      GSC_SERVICE_ACCOUNT_KEY_JSON='{...}'             (inline, e.g. in CI)
 *      GSC_SITE_URL=https://www.khizaroverseas.in/  (must match GSC property, trailing slash matters)
 *
 * DEPENDENCY: requires "google-auth-library" (add to package.json —
 * lighter than the full "googleapis" SDK; this file makes the one REST
 * call it needs directly via axios, same pattern as multiProviderClient.js
 * uses raw axios instead of provider SDKs).
 */

const fs = require("fs");
const axios = require("axios");
const { JWT } = require("google-auth-library");

const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const SEARCH_ANALYTICS_ENDPOINT = (siteUrl) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

let cachedClient = null;

function loadServiceAccountCredentials() {
  if (process.env.GSC_SERVICE_ACCOUNT_KEY_JSON) {
    return JSON.parse(process.env.GSC_SERVICE_ACCOUNT_KEY_JSON);
  }
  if (process.env.GSC_SERVICE_ACCOUNT_KEY_PATH) {
    return JSON.parse(
      fs.readFileSync(process.env.GSC_SERVICE_ACCOUNT_KEY_PATH, "utf8"),
    );
  }
  throw new Error(
    "Missing GSC credentials — set GSC_SERVICE_ACCOUNT_KEY_PATH or GSC_SERVICE_ACCOUNT_KEY_JSON. See gscClient.js header comment for one-time setup steps.",
  );
}

async function getAuthClient() {
  if (cachedClient) return cachedClient;

  const creds = loadServiceAccountCredentials();
  cachedClient = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [SEARCH_CONSOLE_SCOPE],
  });
  return cachedClient;
}

/**
 * Fetch Pages performance for a date range, paginated.
 *
 * @param {Object} opts
 * @param {string} opts.startDate  YYYY-MM-DD
 * @param {string} opts.endDate    YYYY-MM-DD
 * @param {number} [opts.rowLimit] max rows per request (GSC max is 25000)
 * @returns {Promise<Array<{ url: string, clicks: number, impressions: number, ctr: number, position: number }>>}
 */
async function fetchPagePerformance({ startDate, endDate, rowLimit = 25000 }) {
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) {
    throw new Error(
      "Missing GSC_SITE_URL env var (e.g. https://www.khizaroverseas.in/)",
    );
  }

  const authClient = await getAuthClient();
  const { token } = await authClient.getAccessToken();

  if (!token) {
    throw new Error(
      "getAccessToken() returned no token — check that the service account " +
        "JSON key is valid and GSC_SERVICE_ACCOUNT_KEY_PATH/_JSON is set correctly.",
    );
  }

  const allRows = [];
  let startRow = 0;

  // Paginate — GSC caps each response at rowLimit rows.
  // Safety cap of 20 pages (~500k rows) so a mis-set date range can't
  // loop forever against a live API.
  for (let page = 0; page < 20; page++) {
    let response;
    try {
      response = await axios.post(
        SEARCH_ANALYTICS_ENDPOINT(siteUrl),
        {
          startDate,
          endDate,
          dimensions: ["page"],
          rowLimit,
          startRow,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );
    } catch (err) {
      // BUGFIX: axios throws a generic "Request failed with status code
      // 403" that swallows Google's actual error body, which is where the
      // real, actionable reason lives (e.g. "User does not have sufficient
      // permission for site ..."). Surface it instead of hiding it.
      const status = err.response?.status;
      const googleMessage = err.response?.data?.error?.message;
      const googleReason = err.response?.data?.error?.errors?.[0]?.reason;
      throw new Error(
        `GSC API request failed (${status || "no status"}): ` +
          `${googleMessage || err.message}` +
          (googleReason ? ` [reason: ${googleReason}]` : "") +
          ` — requested site: "${siteUrl}"`,
      );
    }

    const rows = response.data?.rows || [];
    for (const row of rows) {
      allRows.push({
        url: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      });
    }

    if (rows.length < rowLimit) break; // last page
    startRow += rowLimit;
  }

  return allRows;
}

module.exports = {
  fetchPagePerformance,
};
