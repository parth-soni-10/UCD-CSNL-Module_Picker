// Live UCD module timetable proxy.
//
// For each module code this fetches the official published timetable from
// UCD's Hub report system (hub.ucd.ie):
//   1. CM802 search  -> "View Timetable" link (encrypted token) for the latest
//                       academic year
//   2. CM801 launch  -> full weekly timetable HTML
// and returns a normalized JSON payload for the frontend.
//
// Works as a Netlify Function (exports.handler) and is also mounted by
// server.js for local development. No dependencies (Node 18+).

"use strict";

const BASE = "https://hub.ucd.ie/usis/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const CACHE_TTL_MS = 30 * 60 * 1000; // keep UCD happy between refreshes
const MAX_CONCURRENCY = 6;
const MAX_CODES = 80;

const TYPE_LABELS = {
  LEC: "Lecture",
  PRA: "Practical",
  TUT: "Tutorial",
  LAB: "Laboratory",
  SEM: "Seminar",
  TST: "Test",
  WSH: "Workshop",
  EXAM: "Final Exam",
  EXM: "Final Exam",
};

// The academic year the site targets (matches catalogue.js): it advances on
// 1 August, when UCD publishes the next year's module set. Only timetables
// for THIS year are ever served — a module whose newest published schedule
// is older is reported as "not timetabled" rather than showing stale times.
function currentCatalogueYear() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}
function targetYearString() {
  const y = currentCatalogueYear();
  return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

// Offline fallback for the allowlist: the committed modules.json. The live
// allowlist is rebuilt from the current catalogue (csnlCodes below) so that
// modules UCD adds to the NL page are fetchable immediately — this frozen
// copy only serves when the catalogue can't be reached.
const FALLBACK_CSNL_CODES = new Set(
  require("../../modules.json")
    .flatMap((t) => t.courses.map((c) => String(c.name).match(/\(([^)]+)\)\s*$/)))
    .map((m) => m && m[1].trim().toUpperCase())
    .filter(Boolean)
);

function codeFromName(name) {
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim().toUpperCase() : String(name).toUpperCase();
}

// The only modules this proxy will fetch: those on UCD's official CSNL
// streams page, AS THE SITE CURRENTLY SERVES THEM (same getCatalogue the
// /catalogue endpoint uses). UCD edits that list every year and mid-year, so
// the allowlist is rebuilt from the live catalogue (cached in-memory for a
// few minutes) rather than frozen to the committed fallback — a module UCD
// just added appears on the site AND becomes fetchable without any code
// change. Defense in depth: the frontend already restricts; this closes the
// API for direct callers.
const { getCatalogue } = require("./catalogue.js");

let csnlCache = null; // { at, codes }
async function csnlCodes() {
  const now = Date.now();
  if (csnlCache && now - csnlCache.at < 5 * 60 * 1000) return csnlCache.codes;
  try {
    const cat = await getCatalogue();
    const codes = new Set(
      cat.themes.flatMap((t) => t.courses.map((c) => codeFromName(c.name)))
    );
    csnlCache = { at: now, codes };
    return codes;
  } catch (e) {
    return FALLBACK_CSNL_CODES;
  }
}

const cache = new Map(); // code -> { fetchedAt, data }

// --- HTTP helpers ---------------------------------------------------------

async function ucdGet(path) {
  const res = await fetch(BASE + path, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "manual",
  });
  const body = await res.text();
  return { status: res.status, body };
}

// --- Parsing --------------------------------------------------------------

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// CM802 search results: { years, rows: [{ code, title, links }], titlesByCode, notTimetabled }
function parseSearchResults(html) {
  const table = html.match(/<table[^>]*id="CM802-1Q"[\s\S]*?<\/table>/i);
  if (!table) return null;
  const rawRows = [...table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
  const years = [];
  const rows = [];
  for (const row of rawRows) {
    if (/<th/i.test(row)) {
      for (const th of row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)) {
        const t = stripTags(th[1]);
        if (/^\d{4}\/\d{2}$/.test(t) && !years.includes(t)) years.push(t);
      }
      continue;
    }
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (tds.length < 2) continue;
    const links = tds.slice(2).map((c) => {
      const m = c.match(
        /W_HU_REPORTING\.P_DISPLAY_REPORT\?p_report=CM801&p_parameters=[A-F0-9]+/
      );
      return m ? m[0] : null;
    });
    rows.push({ code: stripTags(tds[0]), title: stripTags(tds[1]), links });
  }
  const notTimetabled = /This module is currently not timetabled/i.test(table[0]);

  // Titles for untimetabled modules live in the "Select Module" area, in one
  // of two forms:
  //   many matches: <option value="CODE">CODE - Title</option>
  //   single match: static text  CODE - Title  (no <select> at all)
  const titlesByCode = {};
  for (const m of html.matchAll(/<option[^>]*value="([A-Z0-9]+)"[^>]*>\s*([A-Z0-9]+)\s*-\s*([^<]*?)\s*<\/option>/gi)) {
    titlesByCode[m[1].toUpperCase()] = stripTags(m[3]);
  }
  const single = html.match(
    /Select Module:&nbsp;&nbsp;\s*([A-Z0-9]{2,6}\d{3,6})\s*-\s*([^<]*?)(?:\s*<|$)/i
  );
  if (single) titlesByCode[single[1].toUpperCase()] = stripTags(single[2]);
  return { years, rows, titlesByCode, notTimetabled };
}

// "29 Sep 2026" -> "2026-09-29" for chronological comparison
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function normDate(s) {
  const m = String(s).match(/^(\d{2}) (\w{3}) (\d{4})$/);
  if (!m) return String(s);
  return m[3] + "-" + (MONTHS[m[2]] || "00") + "-" + m[1];
}

function timePlusMinutes(start, length) {
  const m = start.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return start;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + length;
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// Split a multi-value cell like "202501 202600" (UCD lists every academic
// term a class runs in, <br>-separated) into its individual values.
function splitCell(v) {
  return String(v || "").split(/\s+/).filter(Boolean);
}

// CM801 timetable page -> normalized structure
function parseTimetable(html, code, year) {
  const out = {
    code,
    trimester: null,
    trimesters: [],
    classes: [],
  };

  const contactTable = html.match(/<table[^>]*id="CM801-4Q"[\s\S]*?<\/table>/i);
  if (contactTable) {
    const rows = [...contactTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
    const headers = rows[0]
      ? [...rows[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
      : [];
    for (const row of rows.slice(1)) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        stripTags(c[1])
      );
      if (headers[0] === "Trimester" && cells[0]) {
        if (!out.trimester) out.trimester = cells[0];
        if (!out.trimesters.includes(cells[0])) out.trimesters.push(cells[0]);
      }
    }
  }

  const weekTable = html.match(/<table[^>]*id="CM801-5Q"[\s\S]*?<\/table>/i);
  if (weekTable && /No schedule details currently available/i.test(weekTable[0])) {
    out.scheduleNote = "No schedule details currently available";
  }
  if (weekTable) {
    const rows = [...weekTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
    let lastWeekStarting = "";
    for (const row of rows.slice(1)) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        stripTags(c[1])
      );
      // Week Starting | Week Number | Actual Date | Day | Start | Length |
      // Offering | Term Code | CRN | Type | Location
      if (cells.length >= 10 && /\d{1,2}:\d{2}/.test(cells[4])) {
        if (/^\d{2} \w{3} \d{4}$/.test(cells[0])) lastWeekStarting = cells[0];
        const lengthMatch = cells[5].match(/(\d+)/);
        const length = lengthMatch ? parseInt(lengthMatch[1], 10) : 0;
        // The term and CRN cells can list several academic years (e.g.
        // "202501 202600" / "28475 16418" when a class runs across years).
        // Keep only the current page year's term and its matching CRN so
        // keys, term codes and CRNs stay clean.
        const terms = splitCell(cells[7]);
        const crns = splitCell(cells[8]);
        const yearPrefix = year ? year.split("/")[0] : "";
        let termCode = terms.length ? terms[terms.length - 1] : "";
        let crn = crns.length ? crns[crns.length - 1] : "";
        if (yearPrefix) {
          const ti = terms.findIndex((t) => t.startsWith(yearPrefix));
          if (ti >= 0) {
            termCode = terms[ti];
            if (crns[ti] !== undefined) crn = crns[ti];
          }
        }
        out.classes.push({
          weekStarting: lastWeekStarting,
          weekNumber: cells[1],
          actualDate: cells[2],
          day: cells[3],
          startTime: cells[4],
          lengthMins: length,
          offering: cells[6],
          termCode,
          crn,
          type: cells[9],
          location: cells[10] || "",
        });
      }
    }
  }

  // Group the weekly rows into unique class offerings.
  const byKey = new Map();
  for (const c of out.classes) {
    const key = [c.type, c.day, c.startTime, c.lengthMins, c.offering, c.termCode].join("|");
    let g = byKey.get(key);
    if (!g) {
      g = {
        type: c.type,
        typeLabel: TYPE_LABELS[c.type] || c.type,
        day: c.day,
        startTime: c.startTime,
        endTime: timePlusMinutes(c.startTime, c.lengthMins),
        lengthMins: c.lengthMins,
        offering: c.offering,
        termCode: c.termCode,
        crn: c.crn,
        location: c.location,
        weeks: [],
        firstDate: c.actualDate,
        lastDate: c.actualDate,
      };
      byKey.set(key, g);
    }
    g.weeks.push(parseInt(c.weekNumber, 10) || 0);
    if (normDate(c.actualDate) < normDate(g.firstDate)) g.firstDate = c.actualDate;
    if (normDate(c.actualDate) > normDate(g.lastDate)) g.lastDate = c.actualDate;
  }
  out.classes = [...byKey.values()].map((c) => {
    const weeks = [...new Set(c.weeks)].sort((a, b) => a - b);
    return { ...c, weeks, term: classTerm(weeks, out.trimesters) };
  });
  out.classes.sort((a, b) => a.day.localeCompare(b.day) || a.startTime.localeCompare(b.startTime));

  return out;
}

// --- Fetching -------------------------------------------------------------

async function fetchModuleTimetable(code) {
  // 1. CM802 search for the exact code
  const searchPath =
    "W_HU_REPORTING.P_LAUNCH_REPORT?p_report=CM802&p_filter1=" +
    encodeURIComponent(code) +
    "&p_BUTTON=Search";
  const search = await ucdGet(searchPath);
  if (search.status !== 200) {
    throw new Error(`UCD search failed (HTTP ${search.status})`);
  }
  const parsed = parseSearchResults(search.body);
  if (!parsed) {
    return { found: false, reason: "Module not found on UCD Hub" };
  }
  if (parsed.rows.length === 0) {
    return {
      found: true,
      title: parsed.titlesByCode[code] || null,
      reason: parsed.notTimetabled
        ? "Module currently not timetabled by UCD"
        : "Module not found on UCD Hub",
    };
  }

  // 2. pick the row for our exact code. The search can return near matches
  //    ("IS41510" returns a HIS41510 row), so never accept a different code —
  //    a module that exists but has no row is simply not timetabled.
  const row = parsed.rows.find(
    (r) => r.code && r.code.toUpperCase() === code.toUpperCase()
  );
  if (!row) {
    return {
      found: true,
      title: parsed.titlesByCode[code] || null,
      reason: parsed.titlesByCode[code]
        ? "Module currently not timetabled by UCD"
        : "Module not found on UCD Hub",
    };
  }

  // 3. Serve ONLY the target academic year's timetable. UCD creates a year
  //    entry before publishing its schedule, so an empty (or missing) target
  //    year is reported as-is — falling back to an older year would show
  //    stale times that may no longer apply.
  const year = targetYearString();
  const yearIdx = parsed.years.indexOf(year);
  const link = yearIdx >= 0 ? row.links[yearIdx] : null;
  if (!link) {
    return {
      found: true,
      title: row.title || parsed.titlesByCode[code] || null,
      year: null,
      reason: `No timetable published for ${year}`,
    };
  }

  const launchPath =
    "W_HU_REPORTING.P_LAUNCH_REPORT?p_report=CM801&p_parameters=" +
    link.split("p_parameters=")[1];
  const launch = await ucdGet(launchPath);
  if (launch.status !== 200) {
    throw new Error(`UCD timetable failed (HTTP ${launch.status})`);
  }
  const tt = parseTimetable(launch.body, code, year);
  tt.found = true;
  tt.title = row.title || parsed.titlesByCode[code] || null;
  tt.year = year;
  tt.semester = deriveSemester(tt.trimesters);
  return tt;
}

// Which trimester(s) a class runs in, as "1", "2" or "1, 2" — derived from
// its week numbers (UCD numbers Autumn weeks 1-12 and Spring weeks 20-33).
// Falls back to the module's own trimesters when a class has no usable week
// data. Same-time classes in disjoint trimesters can never actually run at
// the same time, so consumers use this to keep cross-semester schedules from
// ever being reported as a clash.
function classTerm(weeks, trimesters) {
  if (weeks && weeks.length) {
    const hasAutumn = weeks.some((w) => w <= 12);
    const hasSpring = weeks.some((w) => w >= 13);
    if (hasAutumn && hasSpring) return "1, 2";
    if (hasAutumn) return "1";
    if (hasSpring) return "2";
  }
  return deriveSemester(trimesters);
}

// "Autumn" -> 1, "Spring" -> 2, both -> "1, 2", unknown -> null
function deriveSemester(trimesters) {
  if (!trimesters || trimesters.length === 0) return null;
  const hasAutumn = trimesters.some((t) => /autumn/i.test(t));
  const hasSpring = trimesters.some((t) => /spring/i.test(t));
  if (hasAutumn && hasSpring) return "1, 2";
  if (hasAutumn) return "1";
  if (hasSpring) return "2";
  return null;
}

async function fetchModuleWithCache(code, fresh) {
  if (!fresh) {
    const hit = cache.get(code);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;
  }
  const data = await fetchModuleTimetable(code);
  cache.set(code, { fetchedAt: Date.now(), data });
  return data;
}

async function withConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Handler --------------------------------------------------------------

async function handle(codes, fresh) {
  const results = {};
  const errors = {};
  await withConcurrency(codes, MAX_CONCURRENCY, async (code) => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    try {
      results[c] = await fetchModuleWithCache(c, fresh);
    } catch (e) {
      errors[c] = e && e.message ? e.message : String(e);
    }
  });
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "https://hub.ucd.ie/usis/ (UCD Hub)",
      cacheTTLMinutes: CACHE_TTL_MS / 60000,
      results,
      errors,
    }),
  };
}

async function handler(event) {
  const q = event.queryStringParameters || {};
  const fresh = q.fresh === "1" || q.fresh === "true";
  const raw = (q.codes || "").split(",").map((s) => s.trim()).filter(Boolean);
  const requested = [...new Set(raw)].slice(0, MAX_CODES);
  if (requested.length === 0) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "No module codes supplied (?codes=A,B,C)" }),
    };
  }
  // Reject anything not on the current CSNL list (from the live catalogue;
  // falls back to the committed list if the catalogue can't be reached).
  const allow = await csnlCodes();
  const codes = requested.filter((c) => allow.has(c.toUpperCase()));
  const rejected = requested.filter((c) => !allow.has(c.toUpperCase()));
  const rejectedResults = Object.fromEntries(
    rejected.map((c) => [
      c.toUpperCase(),
      { found: false, reason: "Only modules from UCD's CSNL list are offered" },
    ])
  );
  if (codes.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: "https://hub.ucd.ie/usis/ (UCD Hub)",
        results: rejectedResults,
        errors: {},
      }),
    };
  }
  const handled = JSON.parse((await handle(codes, fresh)).body);
  handled.results = { ...rejectedResults, ...handled.results };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(handled),
  };
}

module.exports = { handler };
