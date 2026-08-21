// Fetches a module's full weekly timetable from UCD's Hub report system.
// Flow: CM802 search -> extract "View Timetable" link for the latest academic year
//       -> CM801 DISPLAY (registers report) -> CM801 LAUNCH (returns the HTML table)
const fs = require("fs");
const path = require("path");

const BASE = "https://hub.ucd.ie/usis/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, jar) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const kv = c.split(";")[0];
    if (kv.includes("=")) {
      const [k, v] = kv.split("=");
      jar[k.trim()] = v;
    }
  }
  const body = await res.text();
  return { status: res.status, url: res.url, body, headers: res.headers };
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extract(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

// Parse the search results page: find rows with module code, return list of
// { year, displayUrl } for each "View Timetable" link, plus module title.
function parseSearchResults(html) {
  // year headers appear in the header row
  const yearMatch = html.match(/Academic Year\s*<[^>]*>([\s\S]*?)<\/tr>/i);
  let years = [];
  if (yearMatch) {
    years = [...yearMatch[1].matchAll(/<td[^>]*>\s*(\d{4}\/\d{2})\s*<\/td>/g)].map(
      (m) => m[1]
    );
  }
  if (years.length === 0) {
    // fallback: any /../ pattern near "View Timetable"
    years = [...html.matchAll(/(\d{4}\/\d{2})/g)].map((m) => m[1]);
  }
  const links = [...html.matchAll(
    /href="(W_HU_REPORTING\.P_DISPLAY_REPORT\?p_report=CM801&p_parameters=[A-F0-9]+)"\s*>\s*View Timetable/g
  )].map((m) => m[1]);
  const titleMatch = html.match(/>\s*(\d{4})\s*-\s*([^<]+?)\s*<a/i);
  return { years, links };
}

function latestYearLink(years, links) {
  // years[i] corresponds to links[i]; choose the latest year
  let bestIdx = -1;
  years.forEach((y, i) => {
    if (links[i]) {
      if (bestIdx === -1 || y > years[bestIdx]) bestIdx = i;
    }
  });
  return bestIdx >= 0 ? links[bestIdx] : null;
}

// Parse the CM801 timetable page into structured offerings.
function parseTimetable(html) {
  const out = { coordinator: null, email: null, trimester: null, contact: [], offerings: [] };

  // Coordinator table (CM801-0Q)
  const coordTable = html.match(/<table[^>]*id="CM801-0Q"[\s\S]*?<\/table>/i);
  if (coordTable) {
    const rows = [...coordTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const dataRow = rows.find((r) => {
      const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
      return cells.length >= 2 && /@/.test(cells[1] ? cells[1] : "");
    });
    if (dataRow) {
      const cells = [...dataRow[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim());
      out.coordinator = cells[0] || null;
      out.email = cells[1] || null;
    }
  }

  // Contact hours table (CM801-4Q): Trimester | Contact Type | Offerings | CRNs
  const contactTable = html.match(/<table[^>]*id="CM801-4Q"[\s\S]*?<\/table>/i);
  if (contactTable) {
    const rows = [...contactTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const headers = rows[0]
      ? [...rows[0][1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
          c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim()
        )
      : [];
    rows.slice(1).forEach((r) => {
      const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim()
      );
      if (cells.length) {
        out.contact.push(Object.fromEntries(headers.map((h, i) => [h, cells[i]])));
        if (headers[0] === "Trimester") out.trimester = cells[0];
      }
    });
  }

  // Weekly schedule table (CM801-5Q)
  const weekTable = html.match(/<table[^>]*id="CM801-5Q"[\s\S]*?<\/table>/i);
  if (weekTable) {
    const rows = [...weekTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let lastWeekStarting = "";
    rows.slice(1).forEach((r) => {
      const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim()
      );
      // Week Starting | Week Number | Actual Date | Day | Start | Length | Offering | Term | CRN | Type | Location
      if (cells.length >= 10 && /\d{2}:\d{2}/.test(cells[4])) {
        if (/^\d{2} \w{3} \d{4}$/.test(cells[0])) lastWeekStarting = cells[0];
        out.offerings.push({
          weekStarting: lastWeekStarting,
          weekNumber: cells[1],
          actualDate: cells[2],
          day: cells[3],
          startTime: cells[4],
          length: cells[5],
          offering: cells[6],
          termCode: cells[7],
          crn: cells[8],
          type: cells[9],
          location: cells[10] || "",
        });
      }
    });
  }
  return out;
}

async function fetchModuleTimetable(code, outDir, tag) {
  const jar = {};
  const enc = (s) => encodeURIComponent(s);
  const searchUrl =
    `${BASE}W_HU_REPORTING.P_LAUNCH_REPORT?p_report=CM802&p_filter1=${enc(code)}&p_BUTTON=Search`;
  const search = await get(searchUrl, jar);
  fs.writeFileSync(path.join(outDir, `${tag}-search.html`), search.body);
  const { years, links } = parseSearchResults(search.body);
  const link = latestYearLink(years, links);
  if (!link) {
    console.log(`${code}: no timetable link (years=[${years}])`);
    return null;
  }
  const displayUrl = `${BASE}${link}`;
  const display = await get(displayUrl, jar);
  fs.writeFileSync(path.join(outDir, `${tag}-display.html`), display.body);
  // meta refresh -> launch URL
  const metaUrl = extract(
    display.body,
    /url=(W_HU_REPORTING\.P_LAUNCH_REPORT\?p_report=CM801&p_parameters=[A-F0-9]+)/
  );
  if (!metaUrl) {
    console.log(`${code}: no meta refresh in display page`);
    return null;
  }
  await sleep(800);
  const launch = await get(`${BASE}${metaUrl}`, jar);
  fs.writeFileSync(path.join(outDir, `${tag}-launch.html`), launch.body);
  const tt = parseTimetable(launch.body);
  tt.code = code;
  tt.year = years[links.indexOf(link)];
  console.log(
    `${code}: year=${tt.year} offerings=${tt.offerings.length} coordinator=${tt.coordinator}`
  );
  return tt;
}

module.exports = { fetchModuleTimetable, parseTimetable, parseSearchResults };

if (require.main === module) {
  const codes = process.argv.slice(2);
  const outDir = path.join(__dirname, "..", "work");
  (async () => {
    for (const code of codes) {
      try {
        await fetchModuleTimetable(code, outDir, code.toLowerCase());
      } catch (e) {
        console.log(`${code}: ERROR ${e.message}`);
      }
      await sleep(500);
    }
  })();
}
