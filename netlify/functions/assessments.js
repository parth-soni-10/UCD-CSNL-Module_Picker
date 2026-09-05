// Module assessment service — UCD-first.
//
// The timetable feed alone can't tell which modules have a FINAL exam: UCD
// publishes exam sittings as timetable rows (EXAM/EXM) for only some modules,
// while others (e.g. GEOG40820) schedule the final exam outside the weekly
// timetable entirely. The authoritative source is each module's own page —
//
//     https://www.ucd.ie/modules/<CODE>
//
// — which carries an "Assessment Strategy" table (report id CB100-30Q) whose
// rows look like:
//
//   Description                                | Timing                     | ... | % of Final Grade
//   -------------------------------------------+----------------------------+-----+------
//   Assignment(Including Essay): ...           | Week 11, Week 12           | ... | 40
//   Exam (In-person): 120 minutes final exam   | End of trimester ... 2 hr  | ... | 60
//
// A module "has a final exam" when any row's description starts with "Exam"
// AND its timing says "End of trimester" (or semester). Mid-terms ("Week 9")
// and other exam-typed components do NOT count — COMP40725's only exam rows
// are a week-9 mid-term, so it stays exam-free.
//
// Persistence: Netlify Blobs in production, in-memory cache locally. The map
// is refreshed when older than TTL_MS; the daily refresh-catalogue cron also
// warms it. If UCD is unreachable the stored map is served with `stale: true`
// so the UI can fall back gracefully instead of blocking the plan builder.

"use strict";

const zlib = require("zlib");

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (e) {
  /* @netlify/blobs is only installed on Netlify; locally we cache in memory */
}

const STORE_NAME = "csnl-assessments";
const KEY = "map";
const VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 6; // parallel module-page fetches
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// in-memory cache for the local dev server (long-lived process)
let memCache = null;
let inflight = null; // dedupe concurrent cold refreshes

const { getCatalogue } = require("./catalogue.js");

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

function cleanCell(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Extracts the Assessment Strategy rows: [{ description, timing, weight }].
// Prefers the stable report id (CB100-30Q); falls back to the heading text.
function parseAssessment(html) {
  let tbl = html.match(/<table[^>]*id="CB100-30Q"[^>]*>[\s\S]*?<\/table>/i);
  if (!tbl) {
    const h = html.match(/<h[2-6][^>]*>[^<]*Assessment\s+Strategy[\s\S]{0,4000}?<table[^>]*>[\s\S]*?<\/table>/i);
    tbl = h;
  }
  if (!tbl) return null;

  const components = [];
  for (const row of tbl[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cleanCell(c[1]));
    if (cells.length < 5) continue; // odd markup guard
    const [description, timing, , , weight] = cells;
    if (!description || /^description$/i.test(description)) continue; // header
    components.push({
      description: description.slice(0, 160),
      timing: (timing || "").slice(0, 80),
      weight: /^\d{1,3}$/.test(weight) ? parseInt(weight, 10) : null,
    });
  }
  return components;
}

// A final exam = an exam-typed component sat at the end of the trimester.
// Mid-terms ("Week 9") and project/assignment rows never match. The timetable
// feed's EXAM/EXM rows are OR-ed in by the consumer (app.js), since some
// modules publish a final sitting there without a matching assessment row
// (COMP47970's week-33 EXM sits after week-12 teaching ends).
function hasFinalExam(components) {
  return components.some(
    (c) =>
      /^\s*exam/i.test(c.description || "") &&
      /end\s+of\s+(the\s+)?(trimester|semester)/i.test(c.timing || "")
  );
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return zlib.gunzipSync(Buffer.from(bytes)).toString("utf8");
    }
    return new TextDecoder("utf-8").decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(code) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchText(`https://www.ucd.ie/modules/${code}`);
      const components = parseAssessment(html);
      if (!components) return { status: "unknown" };
      return { status: "ok", hasFinalExam: hasFinalExam(components), components };
    } catch (e) {
      if (attempt === 1) return { status: "error" };
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function fetchAll(codes) {
  const results = {};
  let ok = 0;
  let i = 0;
  async function worker() {
    while (i < codes.length) {
      const code = codes[i++];
      const r = await fetchOne(code);
      if (r.status === "ok") ok++;
      results[code] = r;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker));
  return { results, okCount: ok };
}

// ---------------------------------------------------------------------------
// storage + orchestration
// ---------------------------------------------------------------------------

async function readStored() {
  if (getStore) {
    try {
      return await getStore(STORE_NAME).getJSON(KEY);
    } catch (e) {
      /* fall through to memory cache */
    }
  }
  return memCache;
}

async function writeStored(value) {
  memCache = value;
  if (getStore) {
    try {
      await getStore(STORE_NAME).setJSON(KEY, value);
    } catch (e) {
      /* memory cache still serves this instance */
    }
  }
}

async function buildFresh(codes) {
  const { results, okCount } = await fetchAll(codes);
  // If UCD mostly failed (WAF, outage) don't clobber a good stored map.
  if (codes.length && okCount / codes.length < 0.5) return null;
  let meta = {};
  try {
    // Recorded so clients can tell when the catalogue changed underneath a
    // cached map (UCD edits the module list mid-year and each 1 August).
    const cat = await getCatalogue();
    meta = { catalogueYear: cat.year ?? null, pageUpdated: cat.pageUpdated ?? null };
  } catch (e) {
    meta = { catalogueYear: null, pageUpdated: null };
  }
  return {
    v: VERSION,
    generatedAt: new Date().toISOString(),
    total: codes.length,
    okCount,
    ...meta,
    results,
  };
}

async function catalogueCodes() {
  const cat = await getCatalogue();
  const codes = [
    ...new Set(
      cat.themes.flatMap((t) =>
        t.courses.map((c) => c.code || String(c.name).match(/\(([^)]+)\)\s*$/)?.[1]).filter(Boolean)
      )
    ),
  ];
  return { cat, codes };
}

async function getAssessments(opts) {
  const force = opts && opts.force;
  const stored = await readStored();

  // Catalogue drift check: when UCD's module list changes (mid-year edits,
  // or the yearly rollover each 1 August), a stored map can cover the wrong
  // set of modules. Detect by comparing the map's total with the live
  // catalogue's — a mismatch counts as stale even inside the TTL.
  let drift = false;
  let liveCodes = null;
  if (!force && stored && stored.v === VERSION) {
    try {
      const { cat, codes } = await catalogueCodes();
      liveCodes = codes;
      drift = stored.total !== codes.length;
    } catch (e) {
      /* catalogue unreachable — treat stored as still valid */
    }
  }

  if (!force && stored && stored.v === VERSION && !drift && Date.now() - Date.parse(stored.generatedAt) < TTL_MS) {
    return stored;
  }
  if (!force && stored && stored.v === VERSION) {
    // Stored map is stale (TTL passed, or the catalogue changed) but usable —
    // refresh opportunistically for the next visitor, but serve the stored
    // map now so responses stay fast.
    if (!inflight) {
      inflight = (async () => {
        try {
          const { cat, codes } = liveCodes ? { cat: null, codes: liveCodes } : await catalogueCodes();
          const fresh = await buildFresh(codes);
          if (fresh) await writeStored(fresh);
        } catch (e) {
          /* keep serving the stale map */
        } finally {
          inflight = null;
        }
      })();
    }
    return { ...stored, stale: true };
  }

  // No usable stored map: build synchronously (cold start / first call).
  try {
    const { cat, codes } = await catalogueCodes();
    const fresh = await buildFresh(codes);
    if (fresh) {
      await writeStored(fresh);
      return fresh;
    }
    if (stored) return { ...stored, stale: true };
    return { v: VERSION, generatedAt: new Date().toISOString(), total: codes.length, okCount: 0, results: {}, error: "ucd unreachable" };
  } catch (e) {
    if (stored) return { ...stored, stale: true };
    throw e;
  }
}

exports.handler = async (event) => {
  try {
    const force = event && event.queryStringParameters && event.queryStringParameters.force === "1";
    const data = await getAssessments({ force });
    const body = JSON.stringify(data);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
      body,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: String((e && e.message) || e) }),
    };
  }
};

// Exposed for the daily cron (refresh-catalogue.js) and tests.
exports.getAssessments = getAssessments;
exports.hasFinalExam = hasFinalExam;
exports.parseAssessment = parseAssessment;
