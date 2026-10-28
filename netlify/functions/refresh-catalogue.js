// Scheduled catalogue refresh - runs twice a month, on the 1st and the 15th
// (one run in the workflow at .github/workflows/refresh-catalogue.yml, which
// calls this route on the deployed site three times with a short gap between
// passes; Pages has no cron triggers of its own). It was a daily schedule until
// 14 Oct 2026: UCD republishes the module list once a year, so checking it every
// day was ~365 scrapes to catch one change.
//
// Re-reads UCD's CSNL streams page on that schedule and updates the stored
// module list the moment UCD changes it (the page's `page_last_update` stamp is
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
    // Force one refresh pass so exam-assessment data stays current even with
    // zero visitors. Module pages change rarely, and a pass covers as much of
    // the map as the host's subrequest ceiling allows (see subrequestBudget in
    // assessments.js) - the three passes of one scheduled run together cover
    // the whole module list.
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
