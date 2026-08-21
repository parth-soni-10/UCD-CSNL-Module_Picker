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

exports.handler = async () => {
  try {
    // No `force`: the stamp-compare path re-reads the page and only rewrites
    // the blob when UCD has actually changed the module list.
    const catalogue = await getCatalogue();
    console.log(
      `Catalogue checked: year=${catalogue.year}, themes=${catalogue.themes.length}, pageUpdated=${catalogue.pageUpdated}, source=${catalogue.source}`
    );
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("Catalogue refresh failed:", e);
    return { statusCode: 500, body: "failed" };
  }
};
