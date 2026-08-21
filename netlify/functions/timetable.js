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
const MAX_CONCURRENCY = 4;
const MAX_CODES = 80;

const TYPE_LABELS = {
  LEC: "Lecture",
  PRA: "Practical",
  TUT: "Tutorial",
  LAB: "Laboratory",
  SEM: "Seminar",
  TST: "Test",
  WSH: "Workshop",
};

const cache = new Map(); // code -> { fetchedAt, data }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- HTTP helpers ---------------------------------------------------------

async function ucdGet(path, jar) {
  const res = await fetch(BASE + path, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "manual",
  });
  for (const cookie of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const kv = cookie.split(";")[0];
    const eq = kv.indexOf("=");
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
  }
  const body = await res.text();
  return { status: res.status, body };
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
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

// CM801 timetable page -> normalized structure
function parseTimetable(html, code) {
  const out = {
    code,
    coordinator: null,
    email: null,
    trimester: null,
    trimesters: [],
    contact: [],
    classes: [],
  };

  const coordTable = html.match(/<table[^>]*id="CM801-0Q"[\s\S]*?<\/table>/i);
  if (coordTable) {
    const rows = [...coordTable[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        stripTags(c[1])
      );
      if (cells.length >= 2 && /@/.test(cells[1])) {
        out.coordinator = cells[0] || null;
        out.email = cells[1] || null;
        break;
      }
    }
  }

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
      if (cells.length) {
        const rec = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
        out.contact.push(rec);
        if (headers[0] === "Trimester" && cells[0]) {
          if (!out.trimester) out.trimester = cells[0];
          if (!out.trimesters.includes(cells[0])) out.trimesters.push(cells[0]);
        }
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
        out.classes.push({
          weekStarting: lastWeekStarting,
          weekNumber: cells[1],
          actualDate: cells[2],
          day: cells[3],
          startTime: cells[4],
          lengthMins: length,
          offering: cells[6],
          termCode: cells[7],
          crn: cells[8],
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
  out.classes = [...byKey.values()].map((c) => ({
    ...c,
    weeks: [...new Set(c.weeks)].sort((a, b) => a - b),
  }));
  out.classes.sort((a, b) => a.day.localeCompare(b.day) || a.startTime.localeCompare(b.startTime));

  return out;
}

// --- Fetching -------------------------------------------------------------

async function fetchModuleTimetable(code, jar) {
  // 1. CM802 search for the exact code
  const searchPath =
    "W_HU_REPORTING.P_LAUNCH_REPORT?p_report=CM802&p_filter1=" +
    encodeURIComponent(code) +
    "&p_BUTTON=Search";
  const search = await ucdGet(searchPath, jar);
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

  // 2. pick the row for our exact code (search may return near matches)
  let row = parsed.rows.find(
    (r) => r.code && r.code.toUpperCase() === code.toUpperCase()
  );
  if (!row) {
    const rows = parsed.rows.filter((r) => r.code);
    if (rows.length === 1) row = rows[0];
  }
  if (!row) {
    return {
      found: false,
      reason: "Module code not in search results",
      title: parsed.titlesByCode[code] || null,
    };
  }

  // 3. choose the latest academic year that has a link
  let bestIdx = -1;
  for (let i = 0; i < parsed.years.length; i++) {
    if (row.links[i] && (bestIdx === -1 || parsed.years[i] > parsed.years[bestIdx])) {
      bestIdx = i;
    }
  }
  if (bestIdx === -1) {
    return {
      found: true,
      title: row.title || parsed.titlesByCode[code] || null,
      year: null,
      reason: "No timetable published",
    };
  }
  const year = parsed.years[bestIdx];
  const link = row.links[bestIdx];

  // 4. CM801 launch returns the timetable HTML directly
  const launchPath =
    "W_HU_REPORTING.P_LAUNCH_REPORT?p_report=CM801&p_parameters=" +
    link.split("p_parameters=")[1];
  const launch = await ucdGet(launchPath, jar);
  if (launch.status !== 200) {
    throw new Error(`UCD timetable fetch failed (HTTP ${launch.status})`);
  }
  const tt = parseTimetable(launch.body, code);
  tt.found = true;
  tt.title = row.title || parsed.titlesByCode[code] || null;
  tt.year = year;
  tt.semester = deriveSemester(tt.trimesters);
  return tt;
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
  const jar = {};
  const data = await fetchModuleTimetable(code, jar);
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
  const codes = [...new Set(raw)].slice(0, MAX_CODES);
  if (codes.length === 0) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "No module codes supplied (?codes=A,B,C)" }),
    };
  }
  return handle(codes, fresh);
}

module.exports = { handler, handle };
