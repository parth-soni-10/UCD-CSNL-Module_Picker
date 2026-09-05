// Scheduled catalogue refresh — runs daily (see netlify.toml).
//
// Re-reads UCD's CSNL streams page every day and updates the stored module
// list the moment UCD changes it (the page's `page_last_update` stamp is
// compared, so the blob is only rewritten when something actually changed).
// This keeps the offerings current even between the yearly publication cycle
// and with zero visitors. The GET endpoint (catalogue.js) also self-heals on
// every request, so the site never goes stale even if this ever fails.

"use strict";

const { getCatalogue } = require("./catalogue.js");
const { getAssessments } = require("./assessments.js");

exports.handler = async () => {
  let catalogueOk = true;
  try {
    // No `force`: the stamp-compare path re-reads the page and only rewrites
    // the blob when UCD has actually changed the module list.
    const catalogue = await getCatalogue();
    console.log(
      `Catalogue checked: year=${catalogue.year}, themes=${catalogue.themes.length}, pageUpdated=${catalogue.pageUpdated}, source=${catalogue.source}`
    );
  } catch (e) {
    // Don't return early: the assessment scraper pulls its code list via
    // getCatalogue (which has its own fallbacks), so a streams-page hiccup
    // shouldn't leave the exam map stale for another day.
    catalogueOk = false;
    console.error("Catalogue refresh failed:", e);
  }

  try {
    // Force a full re-scrape so exam-assessment data stays current even with
    // zero visitors. Module pages change rarely, but a daily re-check keeps
    // the no-exam plan builder and Final Exam badges honest.
    const assessments = await getAssessments({ force: true });
    console.log(
      `Assessments refreshed: total=${assessments.total}, ok=${assessments.okCount}, year=${assessments.catalogueYear ?? "?"}`
    );
    return { statusCode: catalogueOk ? 200 : 207, body: "ok" };
  } catch (e) {
    console.error("Assessments refresh failed:", e);
    return { statusCode: catalogueOk ? 207 : 500, body: catalogueOk ? "assessments failed" : "failed" };
  }
};
