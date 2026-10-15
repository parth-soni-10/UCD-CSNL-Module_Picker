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
// AND either its timing says "End of trimester" (or semester), or its own
// description says "final exam". Mid-terms ("Week 9") and other exam-typed
// in-term tests do NOT count — COMP40725's week-9 mid-term and MIS30010's
// week-8 in-class test stay exam-free — but UCD does not always time the
// final sitting "End of trimester": COMP41740 holds a 60% "final exam" in
// week 12, so the description wording catches it without sweeping in
// unlabelled week-12 in-class tests (COMP31010, COMP40610) or the exam-
// period EEEN40680 sitting.
//
// Persistence: Netlify Blobs in production, in-memory cache locally. The map
// is refreshed when older than TTL_MS; the scheduled refresh-catalogue run also
// warms it. If UCD is unreachable the stored map is served with `stale: true`
// so the UI can fall back gracefully instead of blocking the plan builder.

"use strict";

// The storage backend is injected by whichever host runs this module. The
// Netlify runtime used to supply @netlify/blobs automatically; the Cloudflare
// functions/_router.js now calls setStore() with a KV-backed reader/writer of
// the same shape — get(store, key) / set(store, key, value). With no backend
// the long-lived memory cache serves the instance, which is what the local
// dev server (server.js) relies on.
let storeBackend = null;

// How many outbound subrequests one invocation of this module may make. Local
// Node runs are unbudgeted; the Cloudflare Worker injects its platform ceiling
// through setStore(), because a Workers free-plan invocation may make only 50
// subrequests — and each module page costs two of them (www.ucd.ie redirects
// to hub.ucd.ie). A pass that reaches the ceiling stops early and the next
// pass rotates to the codes it did not get to.
let subrequestBudget = Infinity;

// Some work here has to outlive the response that triggered it (see the
// opportunistic refresh in getAssessments). A long-lived Node process can just
// let that promise run; on Workers, work started after the response is sent is
// cancelled unless it is registered with ExecutionContext.waitUntil(), so the
// Worker injects that through setStore() as well.
let keepAlive = (promise) => promise;

function setStore(backend) {
  storeBackend = backend;
  subrequestBudget =
    backend && Number.isFinite(backend.maxSubrequests) ? backend.maxSubrequests : Infinity;
  keepAlive = (backend && backend.waitUntil) || ((promise) => promise);
}

const STORE_NAME = "csnl-assessments";
const KEY = "map";
const VERSION = 3; // bump invalidates the stored blob when the exam rule changes
const TTL_MS = 24 * 60 * 60 * 1000; // a visitor triggers at most one refresh pass a day
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

// A final exam = an exam-typed component sat at the end of the trimester —
// timed "End of trimester/semester", or explicitly described as a "final
// exam" regardless of timing. Mid-terms ("Week 9") and other in-term exam
// components never match. The timetable feed's EXAM/EXM rows are OR-ed in by
// the consumer (app.js), since some modules publish a final sitting there
// without a matching assessment row (COMP47970's week-33 EXM sits after
// week-12 teaching ends).
function hasFinalExam(components) {
  return components.some(
    (c) =>
      /^\s*exam/i.test(c.description || "") &&
      (/end\s+of\s+(the\s+)?(trimester|semester)/i.test(c.timing || "") ||
        /\bfinal\s+exam/i.test(c.description || ""))
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
      // UCD sometimes answers with a gzip body that fetch() has not decoded
      // (no matching Content-Encoding), so it is gunzipped by hand.
      // DecompressionStream is the portable form of this: it exists in Node
      // 18+ (the local dev server) and in the Workers runtime, where
      // node:zlib may not.
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    }
    return new TextDecoder("utf-8").decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(code, budget) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchText(`https://www.ucd.ie/modules/${code}`);
      const components = parseAssessment(html);
      if (!components) return { status: "unknown" };
      return { status: "ok", hasFinalExam: hasFinalExam(components), components };
    } catch (e) {
      if (attempt === 1) return { status: "error" };
      // A retry costs another two subrequests; only take it if one is left.
      if (budget.left < 2) return { status: "error" };
      budget.left -= 2;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function fetchAll(codes, budget) {
  const results = {};
  let ok = 0;
  let i = 0;
  async function worker() {
    while (i < codes.length) {
      // Checked and reserved with no await in between, so the workers racing
      // on this cannot overshoot the ceiling between them.
      if (budget.left < 2) return;
      budget.left -= 2;
      const code = codes[i++];
      const r = await fetchOne(code, budget);
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
  if (storeBackend) {
    try {
      return await storeBackend.get(STORE_NAME, KEY);
    } catch (e) {
      /* fall through to memory cache */
    }
  }
  return memCache;
}

async function writeStored(value) {
  memCache = value;
  if (storeBackend) {
    try {
      await storeBackend.set(STORE_NAME, KEY, value);
    } catch (e) {
      /* memory cache still serves this instance */
    }
  }
}

/** One refresh pass: fetch the codes that are missing from the stored map or
    least recently fetched, merge them over it, and hand back the merged map.
    A pass is not obliged to reach the whole code list — see subrequestBudget —
    so successive passes (the three of one scheduled run, plus any
    visitor-triggered one) rotate through the map.

    Failures are skipped in the merge instead of replacing entries, so a UCD
    outage or a WAF block can never clobber a map that was already good. That
    replaces the old "mostly-failed pass" guard, which had to decide between
    writing a bad map and writing nothing. */
async function refreshPass(codes, stored) {
  const previous = (stored && stored.results) || {};
  const lastFetched = (entry) => Date.parse((entry && entry.at) || "") || 0;
  const ordered = [...codes].sort((a, b) => lastFetched(previous[a]) - lastFetched(previous[b]));

  const budget = { left: subrequestBudget };
  const { results } = await fetchAll(ordered, budget);
  if (!Object.keys(results).length) return null; // nothing learned — don't rewrite

  const merged = { ...previous };
  const now = new Date().toISOString();
  for (const [code, result] of Object.entries(results)) {
    if (result.status === "error") {
      // Never downgrade an entry we already have: a failed fetch says nothing
      // about the module, so whatever was recorded stays. A first-time failure
      // is still recorded, carrying the attempt time, so the retry cooldown in
      // needsAnotherPass() can tell it was just tried.
      if (!previous[code]) merged[code] = { status: "error", at: now };
      else if (previous[code].status === "error") merged[code] = { ...previous[code], at: now };
      continue;
    }
    merged[code] = { ...result, at: now };
  }

  const okInMerged = codes.filter((code) => merged[code] && merged[code].status === "ok").length;
  // Never store a map with nothing good in it. A total outage should leave the
  // previous map — or the honest "ucd unreachable" response — in place and let
  // the next request try again at once, rather than freezing an all-error map
  // for the length of the retry cooldown below.
  if (!okInMerged) return null;

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
    generatedAt: now,
    total: codes.length,
    okCount: okInMerged,
    ...meta,
    results: merged,
  };
}

// A stored map is only finished when every catalogue code has a good entry.
// `status: "unknown"` is a real answer (the module page has no Assessment
// Strategy table) and counts as finished; a failed attempt does not, but is
// only retried after a cooldown so that one permanently dead module page
// cannot make every visit start a refresh pass.
const RETRY_AFTER_MS = 60 * 60 * 1000;

function needsAnotherPass(stored, codes) {
  return codes.some((code) => {
    const entry = stored.results && stored.results[code];
    if (!entry) return true;
    if (entry.status !== "error") return false;
    return Date.now() - (Date.parse(entry.at || "") || 0) > RETRY_AFTER_MS;
  });
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
  let incomplete = false;
  let liveCodes = null;
  if (!force && stored && stored.v === VERSION) {
    try {
      const { codes } = await catalogueCodes();
      liveCodes = codes;
      drift = stored.total !== codes.length;
      // A chunked pass can leave codes unfetched (see subrequestBudget), or a
      // pass can fail on some codes. Such a map is served honestly but is not
      // finished, and the next visitor should push it on rather than wait out
      // the TTL.
      incomplete = needsAnotherPass(stored, codes);
    } catch (e) {
      /* catalogue unreachable — treat stored as still valid */
    }
  }

  if (
    !force &&
    stored &&
    stored.v === VERSION &&
    !drift &&
    !incomplete &&
    Date.now() - Date.parse(stored.generatedAt) < TTL_MS
  ) {
    return stored;
  }
  if (!force && stored && stored.v === VERSION) {
    // Stored map is stale (TTL passed, or the catalogue changed) but usable —
    // refresh opportunistically for the next visitor, but serve the stored
    // map now so responses stay fast.
    if (!inflight) {
      inflight = (async () => {
        try {
          const { codes } = liveCodes ? { codes: liveCodes } : await catalogueCodes();
          const fresh = await refreshPass(codes, stored);
          if (fresh) await writeStored(fresh);
        } catch (e) {
          /* keep serving the stale map */
        } finally {
          inflight = null;
        }
      })();
      // The response is already on its way, so tell the host the refresh has
      // to survive it. Without this a Worker cancels the in-flight fetches the
      // moment the response is sent and the stored map silently stops
      // advancing — the map looks fine but never gains another module.
      keepAlive(inflight);
    }
    return { ...stored, stale: true };
  }

  // No usable stored map: build synchronously (cold start / first call).
  try {
    const { codes } = await catalogueCodes();
    const fresh = await refreshPass(codes, stored);
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

// Exposed for the scheduled refresh (refresh-catalogue.js) and tests.
exports.getAssessments = getAssessments;
exports.hasFinalExam = hasFinalExam;
exports.parseAssessment = parseAssessment;
// Non-building peek at the stored map (or null) — lets the catalogue attach
// assessment rows when they already exist without ever triggering the
// ~10-30s scrape inside a catalogue request.
exports.peekStored = readStored;
exports.setStore = setStore; // used by functions/_router.js to inject the KV-backed store
