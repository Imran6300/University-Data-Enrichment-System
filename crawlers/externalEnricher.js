const axios = require("axios");
const cheerio = require("cheerio");

// Scrape Wikipedia for basic facts (no auth needed)
async function enrichFromWikipedia(universityName) {
  try {
    const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      universityName.replace(/ /g, "_"),
    )}`;
    const res = await axios.get(searchUrl, { timeout: 8000 });
    return {
      source: "wikipedia",
      description: res.data.extract,
    };
  } catch {
    return null;
  }
}

// Scrape QS rankings page
async function enrichFromQS(universityName) {
  try {
    const searchUrl = `https://www.topuniversities.com/search?search_api_views_fulltext=${encodeURIComponent(
      universityName,
    )}`;
    const res = await axios.get(searchUrl, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/122" },
    });
    const $ = cheerio.load(res.data);
    // parse ranking from results...
    const rank = $(".uni-rank").first().text().trim();
    return rank ? { source: "qs", qsRanking: parseInt(rank) } : null;
  } catch {
    return null;
  }
}

module.exports = { enrichFromWikipedia, enrichFromQS };
