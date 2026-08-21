// Auto-refreshing module catalogue service — UCD-first.
//
// The module list comes from UCD's own CSNL page — "MSc Computer Science by
// Negotiated Learning" — which lists every module CSNL students can take,
// organized into the official streams with core/optional flags, semester,
// credits and comments:
//
//     https://www.ucd.ie/cs/study/postgraduate/nlstreams/
//
// This page is the authoritative, CSNL-only list, so there is no curated data
// to maintain and no auto-discovery to run: whatever UCD publishes there each
// year is exactly what the site offers. The page carries a `page_last_update`
// stamp, so the stored catalogue regenerates the moment UCD changes the list
// (new modules appear, retired ones disappear — with zero code changes).
//
// Fallback chain, in order:
//   1. the nlstreams page (parsed into the official streams);
//   2. UCD's generic current-year module catalogue (MODULESCURRENT), merged
//      with the committed seed — used only if the streams page is unreachable;
//   3. the committed modules.json (same data, frozen) — served if both are
//      unreachable. Timings stay live regardless of which list is served.
//
// Persistence: Netlify Blobs in production (zero-config from functions);
// in-memory cache on the local dev server. Both are guarded, so the function
// works even without @netlify/blobs installed.

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
const VERSION = 6; // bumped when the stored catalogue shape changes
const NL_STREAMS_URL = "https://www.ucd.ie/cs/study/postgraduate/nlstreams/";
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

// ---------------------------------------------------------------------------
// Primary source: the official CSNL streams page
// ---------------------------------------------------------------------------

function cleanCell(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;amp;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseStreamTable(tbl, stream, kind) {
  if (!tbl) return;
  const rows = tbl.split(/<tr[^>]*>/).slice(1);
  for (const row of rows) {
    const codeM = row.match(/ucd\.ie\/modules\/([A-Za-z0-9]+)/i);
    if (!codeM) continue;
    const tds = row.split(/<td[^>]*>/).slice(1).map(cleanCell);
    const linkM = row.match(/title="Go to '([^']+)'/);
    // link titles can be double-encoded (e.g. &amp;amp;), so clean them too
    let title = linkM ? cleanCell(linkM[1]) : tds[0];
    title = title.replace(/\s*\(([A-Z0-9]+)\)\s*$/, "").trim();
    const comments = (tds[3] || "").replace(/^&nbsp;?\s*$/, "");
    stream.modules.push({
      code: codeM[1].toUpperCase(),
      title,
      semester: tds[1] || "",
      credits: parseInt(tds[2] || "0", 10) || 0,
      comments,
      kind,
    });
  }
}

// Parses the nlstreams page into [{ name, modules: [{ code, title, semester,
// credits, comments, kind }] }]. Returns { streams, pageUpdated }.
function parseNlStreams(html) {
  const pageUpdatedM = html.match(/'page_last_update':\s*'([0-9]{2}\/[0-9]{2}\/[0-9]{4})'/);
  const pageUpdated = pageUpdatedM ? pageUpdatedM[1] : null;

  const items = html.split(/<article class="accordion-item"/).slice(1);
  if (!items.length) throw new Error("no stream panels found on the CSNL page");
  const streams = [];

  for (const item of items) {
    const nameM = item.match(/accordion-button[^>]*>([^<]+)</);
    if (!nameM) continue;
    const stream = { name: nameM[1].trim(), modules: [] };
    // Streams either split into Core/Optional sections, or have one flat table
    const coreM = item.match(/Core Modules<\/p>([\s\S]*?)<\/table>/);
    const optM = item.match(/Optional Modules<\/p>([\s\S]*?)<\/table>/);
    if (coreM || optM) {
      parseStreamTable(coreM && coreM[1], stream, "core");
      parseStreamTable(optM && optM[1], stream, "optional");
    } else {
      const body = item.match(/<div class="accordion-body">([\s\S]*)$/)[1];
      const tables = body.split(/<\/table>/);
      for (const t of tables) parseStreamTable(t, stream, "core");
    }
    streams.push(stream);
  }

  if (!streams.length) throw new Error("no streams parsed from the CSNL page");

  // Drop duplicate module rows within a stream (same code + semester)
  for (const s of streams) {
    const seen = new Set();
    s.modules = s.modules.filter((m) => {
      const k = m.code + "|" + m.semester;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { streams, pageUpdated };
}

function buildFromStreams(streams, pageUpdated) {
  const themes = streams.map((s) => ({
    theme: s.name,
    courses: s.modules.map((m) => ({
      name: `${m.title} (${m.code})`,
      credits: m.credits,
      kind: m.kind,
      semester: m.semester,
      comments: m.comments || undefined,
    })),
  }));
  return {
    source: "ucd.ie/cs/study/postgraduate/nlstreams",
    pageUpdated,
    generatedAt: new Date().toISOString(),
    themes,
  };
}

// ---------------------------------------------------------------------------
// Fallback: UCD's generic module catalogue (used if the streams page is down)
// ---------------------------------------------------------------------------

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
    // the module descriptor (short description) follows the title in the cell
    const descRaw = r[1].match(/<div class="col-12 d-none d-sm-inline">([\s\S]*)$/);
    const description = descRaw ? cleanCell(descRaw[1]) : "";
    const creditsMatch = r[6].match(/>([0-9.]+)</);
    byCode.set(code, {
      title,
      credits: creditsMatch ? parseFloat(creditsMatch[1]) : null,
      description,
    });
  }
  if (byCode.size === 0) throw new Error("no modules parsed from catalogue");
  return { termYear: termYear || currentCatalogueYear(), byCode };
}

// UCD's own descriptors sometimes reference module codes outside the CSNL
// list (e.g. prerequisites). The site only offers CSNL modules, so scrub
// those mentions to keep non-CSNL code strings off the page.
const CODE_RE = /\b[A-Z]{2,5}\d{3,6}\b/g;
function scrubNonCsnl(text, csnl) {
  return String(text).replace(CODE_RE, (m) => (csnl.has(m.toUpperCase()) ? m : "a related module"));
}

// Adds each module's short description (from the generic catalogue) to the
// stream courses. Best-effort: modules without a published descriptor keep
// none, and the frontend simply doesn't show one.
function attachDescriptions(themes, byCode) {
  if (!byCode) return themes;
  const csnl = new Set(themes.flatMap((t) => t.courses.map((c) => codeFromName(c.name))));
  for (const t of themes) {
    for (const c of t.courses) {
      const entry = byCode.get(codeFromName(c.name));
      if (entry && entry.description) c.description = scrubNonCsnl(entry.description, csnl);
    }
  }
  return themes;
}

// Attaches short descriptions to a freshly built catalogue object.
async function withDescriptions(cat) {
  try {
    const ucd = await fetchUcdCatalogue();
    cat.themes = attachDescriptions(cat.themes, ucd.byCode);
  } catch (e) {
    /* descriptions are a nice-to-have */
  }
  return cat;
}

function codeFromName(name) {
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : name;
}

// Merges the committed seed with UCD's generic catalogue, refreshing credits
// and attaching descriptions.
function buildFromGenericCatalogue(curated, ucd) {
  const csnl = new Set(curated.flatMap((t) => t.courses.map((c) => codeFromName(c.name))));
  const themes = curated.map((t) => ({
    theme: t.theme,
    courses: t.courses.map((c) => {
      const u = ucd.byCode.get(codeFromName(c.name));
      const course = { name: c.name, credits: u && u.credits != null ? u.credits : c.credits };
      if (u && u.description) course.description = scrubNonCsnl(u.description, csnl);
      return course;
    }),
  }));
  return {
    source: "ucd.ie module catalogue (fallback)",
    generatedAt: new Date().toISOString(),
    themes,
  };
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

async function getCatalogue(opts) {
  const force = opts && opts.force;
  const targetYear = currentCatalogueYear();
  const stored = await readStored();

  // The CSNL page is small and cheap; always re-check it so the list is fresh
  // the moment UCD edits it (the page_last_update stamp changes). The stored
  // blob still protects us when the page is temporarily unreachable.
  if (!force && stored && stored.v === VERSION && stored.year >= targetYear) {
    try {
      const html = await fetchText(NL_STREAMS_URL);
      const { streams, pageUpdated } = parseNlStreams(html);
      if (stored.pageUpdated === pageUpdated) {
        return stored; // unchanged since we last looked
      }
      const fresh = await withDescriptions(buildFromStreams(streams, pageUpdated));
      fresh.year = targetYear;
      fresh.v = VERSION;
      await writeStored(fresh);
      return fresh;
    } catch (e) {
      // streams page down — serve what we have (stored or fallback below)
      if (stored) return stored;
    }
  }

  try {
    const html = await fetchText(NL_STREAMS_URL);
    const { streams, pageUpdated } = parseNlStreams(html);
    const fresh = await withDescriptions(buildFromStreams(streams, pageUpdated));
    fresh.year = targetYear;
    fresh.v = VERSION;
    await writeStored(fresh);
    return fresh;
  } catch (e) {
    // streams page unreachable or unparseable — try UCD's generic catalogue
    try {
      const ucd = await fetchUcdCatalogue();
      const merged = buildFromGenericCatalogue(FALLBACK, ucd);
      merged.year = ucd.termYear;
      merged.v = VERSION;
      await writeStored(merged);
      return merged;
    } catch (e2) {
      // both unreachable — serve the committed seed
      return {
        v: VERSION,
        year: null,
        source: "committed modules.json (fallback)",
        themes: FALLBACK,
      };
    }
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

exports.getCatalogue = getCatalogue; // used by the scheduled refresh function
