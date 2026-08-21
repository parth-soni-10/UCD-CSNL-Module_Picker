// Auto-refreshing module catalogue service.
//
// Serves the curated module list (themes + name + credits only — timings,
// titles and semesters are always fetched live per module by timetable.js).
// Regenerates the list once per year, on 1 August, from the CSNL module
// picker site (or $MODULE_SOURCE_URL), because that is when UCD publishes
// the next academic year's module set. Falls back to the committed
// modules.json whenever the source is unreachable or unparseable, so the
// app keeps working regardless.
//
// Persistence: Netlify Blobs in production (zero-config from functions);
// in-memory cache on the local dev server. Both paths are guarded, so the
// function works even without @netlify/blobs installed.

"use strict";

const FALLBACK = require("../../modules.json");

let getStore = null;
try {
  ({ getStore } = require("@netlify/blobs"));
} catch (e) {
  /* @netlify/blobs is only installed on Netlify; locally we cache in memory */
}

const STORE_NAME = "csnl-catalogue";
const KEY = "modules";
const SOURCE_URL =
  process.env.MODULE_SOURCE_URL || "https://csnl-module-picker.onrender.com/";
const SOURCE_TIMEOUT_MS = 20000;

// in-memory cache for the local dev server (long-lived process)
let memCache = null;

function currentCatalogueYear() {
  // The academic year starts in September; UCD publishes the new module set
  // around 1 August, so on/after 1 Aug the catalogue year advances.
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

function extractFromHtml(html) {
  const marker = "const courseDataString = `";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("courseDataString not found in source");
  const from = start + marker.length;
  const end = html.indexOf("`;", from);
  if (end === -1) throw new Error("courseDataString terminator not found in source");
  const data = JSON.parse(html.slice(from, end).trim());
  if (
    !Array.isArray(data) ||
    !data.every((t) => t && typeof t.theme === "string" && Array.isArray(t.courses))
  ) {
    throw new Error("unexpected source data shape");
  }
  return {
    year: currentCatalogueYear(),
    generatedAt: new Date().toISOString(),
    source: SOURCE_URL,
    themes: data.map((t) => ({
      theme: t.theme,
      courses: t.courses.map((c) => ({ name: c.name, credits: c.credits })),
    })),
  };
}

async function fetchSourceHtml() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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
  const year = currentCatalogueYear();
  const stored = await readStored();

  if (!force && stored && stored.themes && stored.year && stored.year >= year) {
    return stored;
  }

  // New academic year (or first run): regenerate from the live source.
  try {
    const html = await fetchSourceHtml();
    const fresh = extractFromHtml(html);
    if (fresh.themes.length === 0) throw new Error("source produced an empty list");
    await writeStored(fresh);
    return fresh;
  } catch (e) {
    // Source unreachable or unparseable — serve the committed list instead.
    return {
      year: null,
      generatedAt: null,
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
