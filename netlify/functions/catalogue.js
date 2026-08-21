// Auto-refreshing module catalogue service — UCD-first.
//
// On 1 August each year (when UCD publishes the next academic year's module
// set) this service pulls UCD's own published module catalogue and rebuilds
// the module list automatically:
//
//   - Curated themes (the committed modules.json seed) are kept, but their
//     credits are refreshed from UCD's catalogue (credits are no longer
//     curated data).
//   - Every CSNL-relevant module UCD offers that isn't already curated
//     (School of Computer Science + the schools of the curated modules, at
//     levels 3–4) is auto-added under a "More UCD Modules" theme. New
//     modules appear every year with zero code changes.
//   - Modules that UCD retires disappear from that auto theme automatically.
//
// The catalogue's stored year is the academic year UCD itself reports in the
// data (TERMCODE), so if UCD publishes late the service simply keeps
// re-checking on each request until the new year's list appears.
//
// Persistence: Netlify Blobs in production (zero-config from functions);
// in-memory cache on the local dev server. Both are guarded, so the function
// works even without @netlify/blobs installed. If UCD is unreachable, the
// committed modules.json is served instead — timings stay live either way.

"use strict";

const zlib = require("zlib");
const FALLBACK = require("../../modules.json");

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (e) {
  /* @netlify/blobs is only installed on Netlify; locally we cache in memory */
}

const STORE_NAME = "csnl-catalogue";
const KEY = "modules";
const VERSION = 3;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20000;

// in-memory cache for the local dev server (long-lived process)
let memCache = null;

function currentCatalogueYear() {
  // The academic year starts in September; UCD publishes the new module set
  // around 1 August, so on/after 1 Aug the catalogue year advances.
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA },
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

// Fetches UCD's official current-year module catalogue and normalizes it to
// a map keyed by module code. Returns { termYear, byCode }.
async function fetchUcdCatalogue() {
  const page = await fetchText(
    "https://hub.ucd.ie/usis/!W_HU_MENU.P_PUBLISH?p_tag=MODULESCURRENT"
  );
  const tokenMatch = page.match(
    /W_HU_REPORTING\.P_JSON_QUERY\?p_format=ARRAY&p_query=CB470-1&p_parameters=([A-F0-9]+)/
  );
  if (!tokenMatch) throw new Error("module catalogue token not found");
  const jsonText = await fetchText(
    `https://hub.ucd.ie/usis/W_HU_REPORTING.P_JSON_QUERY?p_format=ARRAY&p_query=CB470-1&p_parameters=${tokenMatch[1]}`,
    30000
  );
  const json = JSON.parse(jsonText);
  const rows = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty module catalogue");

  const byCode = new Map();
  let termYear = null;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const codeMatch = r[0].match(/MODULE=([A-Z0-9]{5,9})/);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    if (!termYear) {
      const term = r[0].match(/TERMCODE=([0-9]{6})/);
      if (term) termYear = parseInt(term[1].slice(0, 4), 10);
    }
    const titleMatch = r[1].match(/<strong><a[^>]*>([^<]*)<\/a><\/strong>/);
    const title = (titleMatch ? titleMatch[1] : r[1].replace(/<[^>]*>/g, "")).trim();
    if (!title) continue;
    const creditsMatch = r[6].match(/>([0-9.]+)</);
    const levelMatch = r[5].match(/>([0-9]+)</);
    byCode.set(code, {
      title,
      credits: creditsMatch ? parseFloat(creditsMatch[1]) : null,
      level: levelMatch ? levelMatch[1] : null,
      school: typeof r[7] === "string" ? r[7] : "",
    });
  }
  if (byCode.size === 0) throw new Error("no modules parsed from catalogue");
  return { termYear: termYear || currentCatalogueYear(), byCode };
}

function codeFromName(name) {
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : name;
}

// Programmes run by the School of Computer Science other than CSNL (BSc/MSc
// Computer Science and friends): BDIC (offshore "J" variants), the MSc
// Conversion, the Data Science variants and the MSc Forensic Computing &
// Cybercrime Investigation. Their modules are not options a CSNL student
// picks, so they stay out of the auto theme.
const NOT_CSNL_TITLE =
  /\(conv\)|conversion|\bds\b|\(phd\)|research and scientific communication|forens|investigat|malwar|cybercrime|fraud|financial crime|cell site|osint|threat intelligence|digital evidence|law enforcement|online child|voip and wireless|linux for investigators|programming for investigators|data & database|live data|incident response|cyber risk|leadership in security|trends in cybersecurity|exploitation|cybersecurity case study/i;

// Capstone / non-timetabled "modules" that aren't pickable classes.
const CAPSTONE_TITLE =
  /dissertation|\bproject\b|internship|practicum|final year|\bfyp\b|case stud(y|ies)|summer school|credit recognition/i;

function isCsnlModule(code, u) {
  if (u.school !== "S012") return false; // School of Computer Science only
  if (u.level !== "3" && u.level !== "4") return false; // match the curated profile
  if (/[0-9]J$/.test(code)) return false; // BDIC / offshore variants
  const title = u.title;
  if (NOT_CSNL_TITLE.test(title)) return false;
  if (CAPSTONE_TITLE.test(title)) return false;
  return true;
}

// Merges the curated seed with UCD's catalogue: refreshes credits and
// auto-discovers CSNL-relevant School of Computer Science modules (levels
// 3-4) into a lazy "More UCD Modules" theme. Cross-school modules in the
// curated themes stay curated without expanding their whole schools.
function buildCatalogue(curated, ucd) {
  const curatedCodes = new Set();
  for (const t of curated) for (const c of t.courses) curatedCodes.add(codeFromName(c.name));

  const themes = curated.map((t) => ({
    theme: t.theme,
    courses: t.courses.map((c) => {
      const u = ucd.byCode.get(codeFromName(c.name));
      return { name: c.name, credits: u && u.credits != null ? u.credits : c.credits };
    }),
  }));

  const auto = [];
  for (const [code, u] of ucd.byCode) {
    if (curatedCodes.has(code)) continue;
    if (!isCsnlModule(code, u)) continue;
    auto.push({ name: `${u.title} (${code})`, credits: u.credits });
  }
  auto.sort((a, b) => a.name.localeCompare(b.name));
  if (auto.length) themes.push({ theme: "More UCD Modules", lazy: true, courses: auto });

  return {
    source: "ucd.ie module catalogue",
    generatedAt: new Date().toISOString(),
    themes,
  };
}

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

async function getCatalogue(opts) {
  const force = opts && opts.force;
  const targetYear = currentCatalogueYear();
  const stored = await readStored();

  if (
    !force &&
    stored &&
    stored.v === VERSION &&
    stored.year &&
    stored.year >= targetYear
  ) {
    return stored;
  }

  try {
    const ucd = await fetchUcdCatalogue();
    const merged = buildCatalogue(FALLBACK, ucd);
    merged.year = ucd.termYear;
    merged.v = VERSION;
    await writeStored(merged);
    return merged;
  } catch (e) {
    // UCD catalogue unreachable or unparseable — serve the committed seed.
    return {
      v: VERSION,
      year: null,
      source: "committed modules.json (fallback)",
      themes: FALLBACK,
    };
  }
}

exports.handler = async () => {
  try {
    const catalogue = await getCatalogue();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
      body: JSON.stringify(catalogue),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: String((e && e.message) || e) }),
    };
  }
};
