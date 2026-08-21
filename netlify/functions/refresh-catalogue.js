// Scheduled catalogue refresh — runs 1 August 00:00 UTC (see netlify.toml).
//
// Pre-warms the blob store with the fresh module list on the day UCD
// publishes the next academic year's modules, so the first visitor after
// 1 August gets it instantly. The GET endpoint (catalogue.js) also
// self-heals on its own if this ever fails or runs late.

"use strict";

const { getCatalogue } = require("./catalogue.js");

exports.handler = async () => {
  try {
    const catalogue = await getCatalogue({ force: true });
    console.log(
      `Catalogue refreshed: year=${catalogue.year}, themes=${catalogue.themes.length}, source=${catalogue.source}`
    );
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error("Catalogue refresh failed:", e);
    return { statusCode: 500, body: "failed" };
  }
};
