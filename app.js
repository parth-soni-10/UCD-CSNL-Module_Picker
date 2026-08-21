// CSNL Module Picker — live timings from UCD, refreshed on every page load.

"use strict";

const FUNCTION_URL = "/.netlify/functions/timetable";
const CATALOGUE_URL = "/.netlify/functions/catalogue";
const BATCH_SIZE = 20; // modules per function call (fewer, bigger requests)
const PARALLEL_BATCHES = 4; // function calls run at once
// Auto-refresh cadence; matches the proxy's 30-min cache, so a background
// refresh only pulls new data from UCD once the server cache has expired.
const AUTO_REFRESH_MS = 30 * 60 * 1000;
// UCD's timetable uses Tue/Thu abbreviations
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };
const HOUR_START = 8;
// Grid metrics live as CSS custom properties on .timetable-wrap (screen
// values here are fallbacks); the print stylesheet overrides them and
// app.js re-reads them on beforeprint so events stay aligned.
const FALLBACK_METRICS = { hourH: 62, headH: 44, timeW: 58 };
function gridMetrics() {
  const s = getComputedStyle(els.timetableWrap);
  const num = (name, fb) => {
    const v = parseFloat(s.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fb;
  };
  return {
    hourH: num("--hour-h", FALLBACK_METRICS.hourH),
    headH: num("--head-h", FALLBACK_METRICS.headH),
    timeW: num("--time-w", FALLBACK_METRICS.timeW),
  };
}

const LS_SELECTION = "csnlPicker:selection:v1";
const LS_ACTIVE = "csnlPicker:active:v1";
const LS_THEME = "csnlPicker:theme:v1";
const LS_TIMINGS = "csnlPicker:timings:v1"; // browser cache of fetched UCD timings

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const catalogue = []; // [{ theme, courses: [{ title, code, credits, kind, semester, comments }] }]
const live = new Map(); // code -> timetable payload from the function
let selection = {}; // timetableName -> [{ code, offeringKey }]
let activeTimetable = "Default Timetable";

// ---------------------------------------------------------------------------
// dom refs
// ---------------------------------------------------------------------------

const els = {
  courseList: document.getElementById("course-list"),
  search: document.getElementById("search"),
  moduleCount: document.getElementById("module-count"),
  csnlBadge: document.getElementById("csnl-badge"),
  statusPill: document.getElementById("status-pill"),
  statusText: document.getElementById("status-text"),
  refreshBtn: document.getElementById("refresh-btn"),
  progress: document.getElementById("fetch-progress"),
  progressFill: document.getElementById("fetch-progress-fill"),
  progressText: document.getElementById("fetch-progress-text"),
  totalCredits: document.getElementById("total-credits"),
  summaryList: document.getElementById("summary-list"),
  timetableSwitcher: document.getElementById("timetable-switcher"),
  newTimetableName: document.getElementById("new-timetable-name"),
  addTimetableBtn: document.getElementById("add-timetable-btn"),
  clearBtn: document.getElementById("clear-btn"),
  deleteTimetableBtn: document.getElementById("delete-timetable-btn"),
  timetableGrid: document.getElementById("timetable-grid"),
  timetableEvents: document.getElementById("timetable-events"),
  timetableWrap: document.querySelector(".timetable-wrap"),
  clashWarning: document.getElementById("clash-warning"),
  policyWarning: document.getElementById("policy-warning"),
  printBtn: document.getElementById("print-btn"),
  printHeader: document.getElementById("print-header"),
  printModules: document.getElementById("print-modules"),
  addCodeInput: document.getElementById("add-code-input"),
  addCodeBtn: document.getElementById("add-code-btn"),
  addCodeError: document.getElementById("add-code-error"),
  themeToggle: document.getElementById("theme-toggle"),
  planTarget: document.getElementById("plan-target"),
  planSemester: document.getElementById("plan-semester"),
  planBtn: document.getElementById("plan-btn"),
  planResults: document.getElementById("plan-results"),
  suggestForm: document.getElementById("suggest-form"),
  suggestSubmit: document.getElementById("suggest-submit"),
  suggestText: document.getElementById("suggest-text"),
  suggestError: document.getElementById("suggest-error"),
  suggestDone: document.getElementById("suggest-done"),
  bootScreen: document.getElementById("boot-screen"),
  bootFill: document.getElementById("boot-fill"),
  bootPercent: document.getElementById("boot-percent"),
  bootCountText: document.getElementById("boot-count-text"),
  bootSub: document.getElementById("boot-sub"),
  bootRetry: document.getElementById("boot-retry"),
};

// ---------------------------------------------------------------------------
// boot screen (full-screen loader during the initial live fetch)
// ---------------------------------------------------------------------------

function setAppInert(on) {
  // keep keyboard focus and interaction out of the app while the loader is up
  const topbar = document.querySelector(".topbar");
  const main = document.querySelector("main");
  if (topbar) topbar.inert = on;
  if (main) main.inert = on;
}

function finishBoot() {
  els.bootFill.style.width = "100%";
  els.bootPercent.textContent = "100%";
  els.bootScreen.setAttribute("aria-busy", "false");
  els.bootScreen.classList.add("done");
  setAppInert(false);
}

function failBoot(message) {
  els.bootSub.textContent = message;
  els.bootCountText.classList.add("error");
  els.bootCountText.textContent = "Timings unavailable — retry";
  els.bootRetry.classList.remove("hidden");
  els.bootScreen.setAttribute("aria-busy", "false");
  setAppInert(false);
}

els.bootRetry.addEventListener("click", () => location.reload());

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function offeringKey(cls) {
  return `${cls.day}|${cls.startTime}|${cls.type}|${cls.offering}`;
}

function parseName(name) {
  // the module code is the LAST parenthetical group, e.g.
  // "Advanced Machine Learning (COMP47590)" -> COMP47590
  const m = [...name.matchAll(/\(([^)]+)\)/g)].pop();
  const code = m ? m[1].trim() : name;
  const title = name.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  return { title, code };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SELECTION) || "{}");
    if (s && typeof s === "object") selection = s;
  } catch (e) {
    /* ignore */
  }
  try {
    const a = localStorage.getItem(LS_ACTIVE);
    if (a) activeTimetable = a;
  } catch (e) {
    /* ignore */
  }
  if (!selection[activeTimetable]) selection[activeTimetable] = [];
}

function saveState() {
  localStorage.setItem(LS_SELECTION, JSON.stringify(selection));
  localStorage.setItem(LS_ACTIVE, activeTimetable);
}

// --- browser cache of fetched UCD timings -----------------------------------
// The full `live` payloads are cached in localStorage so a returning visit
// renders instantly from the saved timetables, then refreshes in the
// background from UCD (stale-while-revalidate). Nothing here ever replaces
// the live fetch — the cache only makes the first paint immediate.

function loadTimingsCache() {
  try {
    const raw = localStorage.getItem(LS_TIMINGS);
    if (!raw) return 0;
    const { results } = JSON.parse(raw);
    if (!results || typeof results !== "object") return 0;
    let n = 0;
    for (const [code, data] of Object.entries(results)) {
      if (data && typeof data === "object") {
        live.set(code, data);
        n++;
      }
    }
    return n;
  } catch (e) {
    return 0; // private mode / quota — just fetch live as before
  }
}

function saveTimingsCache() {
  try {
    const keep = new Set(curatedCodes());
    const results = {};
    for (const [code, data] of live) {
      if (keep.has(code) && data) results[code] = data;
    }
    localStorage.setItem(
      LS_TIMINGS,
      JSON.stringify({ savedAt: Date.now(), results })
    );
  } catch (e) {
    /* quota exceeded / private mode — cache is best-effort */
  }
}

// deterministic per-module hue; the CSS turns it into theme-aware event colors
function hueFor(code) {
  let hash = 0;
  for (const ch of code) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

// ---------------------------------------------------------------------------
// semester awareness
// ---------------------------------------------------------------------------

// UCD's academic year: Semester 1 (Autumn) = Aug-Dec, Semester 2 (Spring) = Jan-May
function getCurrentSemester() {
  const month = new Date().getMonth(); // 0-indexed
  // Aug(7) - Dec(11) = Semester 1
  // Jan(0) - May(4) = Semester 2
  // Jun(5) - Jul(6) = break (return null)
  if (month >= 7 || month <= 4) return month >= 7 ? "1" : "2";
  return null; // summer break
}

// ---------------------------------------------------------------------------
// theme (light / dark / system)
// ---------------------------------------------------------------------------

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark" || theme === "light") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme"); // follow the OS
  }
  const dark = theme === "dark" || (!theme && systemPrefersDark());
  els.themeToggle.setAttribute("aria-pressed", String(dark));
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(LS_THEME);
  } catch (e) {
    /* ignore */
  }
  applyTheme(stored);

  els.themeToggle.addEventListener("click", () => {
    // first click makes the choice explicit; afterwards it's a plain toggle
    const explicit = document.documentElement.getAttribute("data-theme");
    const isDark = explicit === "dark" || (!explicit && systemPrefersDark());
    const next = isDark ? "light" : "dark";
    try {
      localStorage.setItem(LS_THEME, next);
    } catch (e) {
      /* ignore */
    }
    applyTheme(next);
  });

  // while the user hasn't chosen explicitly, track the OS preference live
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (!document.documentElement.getAttribute("data-theme")) applyTheme(null);
    });
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Do two class rows actually run at the same time? Same day + overlapping
// times + overlapping weeks. If either side lacks week data, fall back to
// treating an overlapping time as a clash. Shared by the timetable renderer
// and the clash-free plan builder, so both use identical rules.
function classesClash(a, b) {
  if (!a || !b || a.day !== b.day) return false;
  const s1 = timeToMinutes(a.startTime);
  const e1 = timeToMinutes(a.endTime);
  const s2 = timeToMinutes(b.startTime);
  const e2 = timeToMinutes(b.endTime);
  if (Math.max(s1, s2) >= Math.min(e1, e2)) return false; // times don't overlap
  const wa = a.weeks && a.weeks.length ? a.weeks : null;
  const wb = b.weeks && b.weeks.length ? b.weeks : null;
  if (wa && wb) return wa.some((w) => wb.includes(w));
  return true;
}

// ---------------------------------------------------------------------------
// fetching live timings
// ---------------------------------------------------------------------------

async function fetchBatch(codes, fresh) {
  const url = `${FUNCTION_URL}?codes=${encodeURIComponent(codes.join(","))}${
    fresh ? "&fresh=1" : ""
  }`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Turn a raw fetch error into a human-readable, actionable reason.
function friendlyFailure(reason) {
  const r = String(reason || "");
  const m = r.match(/HTTP (\d{3})/);
  if (m) {
    const code = parseInt(m[1], 10);
    if (code === 429) return "UCD is rate-limiting requests — wait a moment and retry";
    if (code === 408 || code === 504) return "UCD's timetable service timed out — retry";
    if (code >= 500) return `UCD's timetable service returned an error (HTTP ${code}) — retry`;
    return `UCD rejected the request (HTTP ${code}) — retry`;
  }
  if (/failed to fetch|networkerror|load failed|net::/i.test(r)) {
    return "No response from UCD — check your internet connection, or UCD may be down — retry";
  }
  if (/abort|timeout/i.test(r)) return "The request timed out — retry";
  return r || "Unknown error — retry";
}

// Re-fetch a single module that failed to load, bypassing the server cache.
async function retryModule(code) {
  const btn = document.querySelector(`.retry-module[data-code="${CSS.escape(code)}"]`);
  if (btn) btn.textContent = "Retrying…";
  try {
    const json = await fetchBatch([code], true);
    const d = json.results && json.results[code];
    if (d) live.set(code, { ...d, fetchedAt: json.generatedAt });
    else live.set(code, { found: false, reason: "Unavailable" });
  } catch (e) {
    live.set(code, { found: false, reason: `Fetch error: ${e.message}`, failed: true });
  }
  updateStatus();
  refreshUI();
  saveTimingsCache();
}

// fresh: bypass the server's 30-min cache and pull straight from UCD
// refreshAll: re-fetch every module even if we already have it (used for the
//             background refresh after restoring the browser cache)
async function fetchAllTimings(fresh, refreshAll) {
  const codes = [];
  for (const code of curatedCodes()) if (!live.has(code)) codes.push(code);

  if (codes.length === 0 && !fresh && !refreshAll) return;

  const toFetch = fresh || refreshAll ? curatedCodes() : codes;
  const total = toFetch.length;
  let done = 0;

  const progressEl = els.progress;
  progressEl.classList.remove("hidden");

  const setProgress = () => {
    const pct = Math.round((done / total) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressText.textContent = `Fetching live timetables from UCD… ${done}/${total}`;
    els.bootFill.style.width = `${pct}%`;
    els.bootPercent.textContent = `${pct}%`;
    els.bootCountText.textContent = `${done}/${total} modules`;
  };

  const batches = [];
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE)
    batches.push(toFetch.slice(i, i + BATCH_SIZE));

  let cursor = 0;
  const workers = Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const json = await fetchBatch(batch, fresh);
        for (const [code, data] of Object.entries(json.results || {})) {
          live.set(code, { ...data, fetchedAt: json.generatedAt });
        }
        // remember failures so a later refresh doesn't re-request forever
        for (const code of batch) {
          if (!live.has(code)) live.set(code, { found: false, reason: "Unavailable" });
        }
      } catch (e) {
        for (const code of batch) {
          live.set(code, {
            found: false,
            reason: `Fetch error: ${e.message}`,
            failed: true, // network/proxy error — distinct from "no timetable"
          });
        }
      } finally {
        done += batch.length;
        setProgress();
        refreshUI();
        saveTimingsCache(); // keep the browser cache current as results land
      }
    }
  });

  await Promise.all(workers);
  progressEl.classList.add("hidden");
  refreshUI();
  updateStatus();
  saveTimingsCache();
}

function updateStatus() {
  const liveCount = [...live.entries()]
    .filter(([code, d]) => d.found && d.classes && d.classes.length)
    .length;
  const noTtCount = [...live.entries()].filter(
    ([, d]) => d.found !== undefined && (d.found === false || !d.classes || d.classes.length === 0)
  ).length;
  const total = curatedCodes().length;
  const ts = new Date();
  const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  els.statusPill.classList.remove("loading", "error");
  const pending = total - liveCount - noTtCount;
  const currentSem = getCurrentSemester();
  let status = `Live UCD timings · ${liveCount}/${total} modules`;
  if (currentSem) status += ` · Semester ${currentSem} now`;
  if (noTtCount) status += ` · ${noTtCount} no timetable yet`;
  if (pending > 0) status += ` · ${pending} pending`;
  status += ` · updated ${time}`;
  els.statusText.textContent = status;
}

function setLoadingStatus(text) {
  els.statusPill.classList.add("loading");
  els.statusPill.classList.remove("error");
  els.statusText.textContent = text;
}

function setErrorStatus(text) {
  els.statusPill.classList.add("error");
  els.statusPill.classList.remove("loading");
  els.statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

// Self-check metadata from the catalogue function: whether the served list
// was re-verified against UCD's CSNL page on this load, and the page's own
// last-update stamp.
let catalogueMeta = null;

function updateCsnlBadge() {
  if (!els.csnlBadge) return;
  if (catalogueMeta && catalogueMeta.verified) {
    els.csnlBadge.classList.remove("warn");
    els.csnlBadge.title =
      "Verified against UCD's CSNL streams page" +
      (catalogueMeta.pageUpdated ? ` (updated ${catalogueMeta.pageUpdated})` : "") +
      ". Only modules on that list are offered.";
  } else {
    els.csnlBadge.classList.add("warn");
    els.csnlBadge.title =
      "Could not re-verify against UCD's CSNL page on this load — showing the last known list. Only CSNL modules are offered.";
  }
}

// unique module codes (streams cross-list some modules, so dedupe)
function curatedCodes() {
  const codes = [];
  for (const t of catalogue) for (const c of t.courses) codes.push(c.code);
  return [...new Set(codes)];
}

let csnlSet = null;
function csnlCodes() {
  if (!csnlSet) csnlSet = new Set(curatedCodes());
  return csnlSet;
}

// Descriptions are UCD's own text and may reference modules outside the CSNL
// list (prerequisites etc). The site only offers CSNL modules, so scrub those
// mentions at the display boundary too.
function scrubNonCsnl(text) {
  return String(text).replace(/\b[A-Z]{2,5}\d{3,6}\b/g, (m) =>
    csnlCodes().has(m.toUpperCase()) ? m : "a related module"
  );
}

function moduleInfo(code) {
  for (const t of catalogue)
    for (const c of t.courses) if (c.code === code) return c;
  // defensive fallback — the picker only offers CSNL modules
  return { code, title: (live.get(code) || {}).title || code, credits: null };
}

function refreshUI() {
  render();
  renderSummary();
  renderSwitcher();
  renderTimetable();
  renderPolicyWarning();
  renderPrintInfo();
}

// Fills the print-only header and module legend (visible only in print).
function renderPrintInfo() {
  const today = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const sem = getCurrentSemester();
  els.printHeader.innerHTML = `
    <div class="pi-title">CSNL Module Picker — ${esc(activeTimetable)}</div>
    <div class="pi-sub">${today}${sem ? ` · Semester ${sem}` : ""}</div>
  `;
  const codes = [...new Set(currentSelection().map((s) => s.code))];
  let credits = 0;
  const rows = [];
  for (const code of codes) {
    const info = moduleInfo(code);
    if (info && info.credits) credits += info.credits;
    rows.push(`<div class="pi-mod"><span class="pi-code">${esc(code)}</span><span class="pi-name">${esc(info.title)}</span><span class="pi-cred">${info.credits ? info.credits + " cr" : ""}</span></div>`);
  }
  els.printModules.innerHTML =
    rows.join("") +
    (rows.length
      ? `<div class="pi-total">Total: ${credits} credits</div>`
      : `<p class="muted">Nothing selected yet.</p>`);
}

// Does a module title match the search term? Plain substring, or the term as
// initials of consecutive words ("ml" finds "Machine Learning", "ai" finds
// "Artificial Intelligence").
function titleMatches(title, term) {
  const t = title.toLowerCase();
  if (t.includes(term)) return true;
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  for (let i = 0; i < words.length; i++) {
    let initials = "";
    for (let j = i; j < words.length && j < i + 4; j++) initials += words[j][0];
    if (initials.startsWith(term)) return true;
  }
  return false;
}

function render() {
  const term = els.search.value.toLowerCase().trim();
  const list = els.courseList;
  // remember which themes are expanded so re-renders (selection changes,
  // timing fetch progress) don't collapse them
  const expanded = new Set();
  for (const t of list.querySelectorAll(".theme-toggle:not(.collapsed)")) {
    expanded.add(t.querySelector("span").childNodes[0].textContent.trim());
  }
  list.innerHTML = "";

  const themes = catalogue.map((t) => ({
    name: t.theme,
    courses: t.courses.filter(
      (c) => !term || titleMatches(liveTitle(c.code), term) || c.code.toLowerCase().includes(term)
    ),
  }));
  const shownCodes = new Set();
  for (const themeObj of themes) {
    if (themeObj.courses.length === 0) continue;
    for (const c of themeObj.courses) shownCodes.add(c.code);

    const section = document.createElement("div");
    section.className = "theme";
    const isExpanded = expanded.has(themeObj.name);
    section.innerHTML = `
      <button class="theme-toggle${isExpanded ? "" : " collapsed"}">
        <span>${esc(themeObj.name)}<span class="theme-count">${themeObj.courses.length}</span></span>
        <span class="chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </button>
      <div class="theme-body${isExpanded ? "" : " hidden"}"></div>
    `;
    const body = section.querySelector(".theme-body");
    for (const c of themeObj.courses) body.appendChild(renderCourseCard(c));
    list.appendChild(section);
  }

  if (shownCodes.size === 0) {
    list.innerHTML = `<p class="empty">No modules found matching “${esc(term)}”.</p>`;
  }
  els.moduleCount.textContent = `${shownCodes.size} modules`;
}

function liveTitle(code) {
  const data = live.get(code);
  return (data && data.title) || code;
}

const UCD_MODULE_BASE = "https://www.ucd.ie/modules/";

function renderCourseCard(c) {
  const data = live.get(c.code);
  const card = document.createElement("div");
  card.className = "course-card";
  card.dataset.code = c.code;

  // highlight if module matches current semester
  const currentSem = getCurrentSemester();
  const moduleSem = c.semester || (data && data.semester);
  if (currentSem && moduleSem && moduleSem.includes(currentSem)) {
    card.classList.add("current-semester");
  }

  const badges = [];
  if (c.kind === "core" || c.kind === "optional") {
    badges.push({ text: c.kind === "core" ? "Core" : "Optional", cls: c.kind });
  }
  const semester = c.semester || (data && data.semester);
  if (semester) {
    badges.push(semester === "1, 2" ? "Both semesters" : "Semester " + semester);
  }
  if (c.credits) badges.push(`${c.credits} cr`);
  if (data && data.found && data.year) {
    const terms =
      data.trimesters && data.trimesters.length > 1
        ? data.trimesters.join(" + ")
        : data.trimester || "";
    badges.push(`${data.year} · ${terms}`.trim());
  }
  const failed = data && data.failed;
  const noTimetable =
    !failed &&
    data &&
    data.found !== undefined &&
    (data.found === false || !data.classes || data.classes.length === 0);
  if (failed) badges.push({ text: "Load failed", cls: "fail" });
  if (noTimetable) badges.push({ text: "No timetable yet", cls: "none" });

  card.innerHTML = `
    <div class="card-top">
      <div>
        <h3><a class="module-link" href="${UCD_MODULE_BASE}${esc(c.code)}" target="_blank" rel="noopener" title="View ${esc(c.code)} on ucd.ie">${esc(liveTitle(c.code))}</a></h3>
        <div class="badges">
          ${badges.map((b) => `<span class="badge${b.cls ? " " + esc(b.cls) : ""}${data && data.found ? " live" : ""}">${esc(b.text !== undefined ? b.text : b)}</span>`).join("")}
        </div>
      </div>
      <div class="card-code-col">
        <span class="badge">${esc(c.code)}</span>
      </div>
    </div>
    ${c.description ? `<p class="card-desc">${esc(scrubNonCsnl(c.description))}</p>` : ""}
    ${c.comments ? `<div class="card-note" title="From the UCD CSNL streams page">${esc(c.comments)}</div>` : ""}
    <div class="offerings" data-code="${esc(c.code)}"></div>
  `;

  const offeringsEl = card.querySelector(".offerings");
  if (!data) {
    offeringsEl.innerHTML = `<div class="note loading">Loading live timetable…</div>`;
  } else if (data.failed) {
    // the fetch itself failed (network/UCD down) — explain why and offer a retry
    offeringsEl.innerHTML = `<div class="note warn fail">Couldn't load this timetable — ${esc(friendlyFailure(data.reason))}. <button class="retry-module" data-code="${esc(c.code)}">Retry</button></div>`;
  } else if (data.found === false || !data.classes || data.classes.length === 0) {
    const note = data.scheduleNote || data.reason || "No classes scheduled";
    offeringsEl.innerHTML = `<div class="note warn">No timetable published${data.year ? ` for ${esc(data.year)}` : ""} yet — ${esc(note)}.</div>`;
  } else {
    for (const cls of data.classes) {
      const key = offeringKey(cls);
      const checked = currentSelection().some(
        (s) => s.code === c.code && s.offeringKey === key
      );
      const weeks = cls.weeks && cls.weeks.length ? `Weeks ${cls.weeks[0]}–${cls.weeks[cls.weeks.length - 1]}` : "";
      const loc = cls.location ? ` · ${esc(cls.location)}` : "";
      const div = document.createElement("label");
      div.className = "offering" + (checked ? " checked" : "");
      div.innerHTML = `
        <input type="checkbox" ${checked ? "checked" : ""} data-code="${esc(c.code)}" data-key="${esc(key)}" />
        <div class="off-main">
          <div class="off-type">${esc(cls.typeLabel)} ${cls.offering ? "· Offering " + esc(cls.offering) : ""}</div>
          <div class="off-time">${esc(cls.day)} ${esc(cls.startTime)}–${esc(cls.endTime)}</div>
          <div class="off-meta">${weeks}${loc}</div>
        </div>
      `;
      offeringsEl.appendChild(div);
    }
  }
  return card;
}

function currentSelection() {
  return selection[activeTimetable] || [];
}

function toggleOffering(code, key, checked) {
  let sel = currentSelection();
  if (checked) {
    if (!sel.some((s) => s.code === code && s.offeringKey === key)) {
      sel = sel.concat({ code, offeringKey: key });
    }
  } else {
    sel = sel.filter((s) => !(s.code === code && s.offeringKey === key));
  }
  selection[activeTimetable] = sel;
  saveState();
  refreshUI();
  syncUrl();
}

// ---------------------------------------------------------------------------
// summary + credits
// ---------------------------------------------------------------------------

function renderSummary() {
  const sel = currentSelection();
  const list = els.summaryList;
  list.innerHTML = "";

  const byCode = new Map();
  for (const s of sel) {
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s.offeringKey);
  }

  let credits = 0;
  for (const [code, keys] of byCode) {
    const info = moduleInfo(code);
    const data = live.get(code);
    if (info && info.credits) credits += info.credits;
    const detail = keys
      .map((k) => {
        const cls = data && data.classes ? data.classes.find((x) => offeringKey(x) === k) : null;
        return cls ? `${cls.typeLabel} ${cls.day} ${cls.startTime}` : k.split("|")[0];
      })
      .join(", ");
    const item = document.createElement("div");
    item.className = "summary-item";
    item.innerHTML = `
      <div>
        <div class="s-code">${esc(liveTitle(code))}</div>
        <div class="s-detail">${esc(detail)}</div>
      </div>
      <button class="s-x" data-code="${esc(code)}" title="Remove from selection" aria-label="Remove ${esc(liveTitle(code))} from selection">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    `;
    list.appendChild(item);
  }

  if (sel.length === 0) {
    list.innerHTML = `<p class="muted" style="margin:4px 2px 12px">Nothing selected yet — tick classes in the module list.</p>`;
  }
  els.totalCredits.textContent = `${credits} credits`;
}

// ---------------------------------------------------------------------------
// weekly timetable
// ---------------------------------------------------------------------------

function createGrid() {
  els.timetableGrid.innerHTML = "";
  const todayName = DAY_NAMES[new Date().getDay()];
  DAYS.forEach((day, i) => {
    const h = document.createElement("div");
    h.className = "day-header" + (day === todayName ? " today" : "");
    h.textContent = day;
    h.style.gridColumn = `${i + 2} / ${i + 3}`;
    els.timetableGrid.appendChild(h);
  });
  for (let i = 0; i < 12; i++) {
    const hour = HOUR_START + i;
    const t = document.createElement("div");
    t.className = "time-slot";
    t.textContent = `${hour}:00`;
    t.style.gridRow = `${i + 2} / ${i + 3}`;
    els.timetableGrid.appendChild(t);
    for (let j = 0; j < 5; j++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.style.gridRow = `${i + 2} / ${i + 3}`;
      cell.style.gridColumn = `${j + 2} / ${j + 3}`;
      els.timetableGrid.appendChild(cell);
    }
  }
}

// Hover tooltip for a timetable event: module metadata + class details.
function evTooltipMarkup(info, data, cls, code) {
  const badges = [];
  if (info.kind === "core" || info.kind === "optional") {
    badges.push(`<span class="tt-badge ${esc(info.kind)}">${info.kind === "core" ? "Core" : "Optional"}</span>`);
  }
  if (info.credits) badges.push(`<span class="tt-badge">${info.credits} cr</span>`);
  const sem = info.semester || (data && data.semester);
  if (sem) badges.push(`<span class="tt-badge">Sem ${sem.replace(",", "+")}</span>`);
  const weeks = cls.weeks && cls.weeks.length ? `Weeks ${cls.weeks[0]}–${cls.weeks[cls.weeks.length - 1]}` : "";
  return `
    <div class="ev-tooltip" role="tooltip">
      <div class="tt-title">${esc(info.title)} <span class="mono">${esc(code)}</span></div>
      <div class="tt-sub">${data && data.year ? esc(data.year) + " · " : ""}${esc(cls.typeLabel)} · ${esc(cls.day)} ${esc(cls.startTime)}–${esc(cls.endTime)}</div>
      <div class="tt-divider"></div>
      ${badges.length ? `<div class="tt-row">${badges.join("")}</div>` : ""}
      ${weeks ? `<div class="tt-row">${esc(weeks)}</div>` : ""}
      ${cls.location ? `<div class="tt-row">📍 ${esc(cls.location)}</div>` : ""}
      ${cls.offering ? `<div class="tt-row">Offering ${esc(cls.offering)} · CRN ${esc(cls.crn || "—")}</div>` : ""}
    </div>`;
}

function renderTimetable() {
  els.timetableEvents.innerHTML = "";
  let hasClash = false;
  const events = [];

  for (const s of currentSelection()) {
    const info = moduleInfo(s.code);
    const data = live.get(s.code);
    if (!info || !data || !data.classes) continue;
    const cls = data.classes.find((x) => offeringKey(x) === s.offeringKey);
    if (!cls) continue;

    const m = gridMetrics();
    const start = timeToMinutes(cls.startTime);
    const end = timeToMinutes(cls.endTime);
    const top = (start / 60 - HOUR_START) * m.hourH + m.headH;
    const height = ((end - start) / 60) * m.hourH;
    const dayIndex = DAY_INDEX[cls.day];
    if (!dayIndex) continue;

    const el = document.createElement("div");
    el.className = "timetable-event";
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(height, 24)}px`;
    el.style.left = `calc(${m.timeW}px + ${dayIndex - 1} * ((100% - ${m.timeW}px) / 5) + 3px)`;
    el.style.width = `calc((100% - ${m.timeW}px) / 5 - 6px)`;
    el.style.setProperty("--ev-hue", hueFor(s.code));
    el.innerHTML = `
      <div class="ev-title">${esc(info.title)}</div>
      <div class="ev-time">${esc(cls.typeLabel)} · ${esc(cls.startTime)}–${esc(cls.endTime)}</div>
      ${evTooltipMarkup(info, data, cls, s.code)}
    `;
    const tip = el.querySelector(".ev-tooltip");
    if (tip) {
      el.addEventListener("mouseenter", () => {
        // flip above/below so the tooltip isn't clipped at the grid edges
        const wrap = els.timetableWrap.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        tip.style.top = "";
        tip.style.bottom = "";
        if (rect.top - wrap.top < 160) {
          tip.style.top = "calc(100% + 8px)";
        } else {
          tip.style.bottom = "calc(100% + 8px)";
        }
        tip.classList.add("show");
      });
      el.addEventListener("mouseleave", () => tip.classList.remove("show"));
    }
    events.push({ el, cls });
  }

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (classesClash(events[i].cls, events[j].cls)) {
        hasClash = true;
        events[i].el.classList.add("clash");
        events[j].el.classList.add("clash");
      }
    }
  }

  els.clashWarning.classList.toggle("hidden", !hasClash);
  for (const ev of events) els.timetableEvents.appendChild(ev.el);
}

// ---------------------------------------------------------------------------
// URL state: reflect the view (?q=search & ?t=timetable & ?s=selection) so a
// link can be deep-linked and shared. replaceState keeps the back button free
// of noise.
// ---------------------------------------------------------------------------

// Selection -> compact, readable URL form: "CODE:day.start.type.offering,..."
// (the internal offeringKey's "|" becomes "." so URLs stay clean).
function encodeSelection(sel) {
  return sel.map((s) => `${s.code}:${s.offeringKey.replace(/\|/g, ".")}`).join(",");
}

function decodeSelection(raw) {
  const out = [];
  for (const part of String(raw).split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const code = part.slice(0, idx).toUpperCase();
    const key = part.slice(idx + 1).replace(/\./g, "|");
    if (/^[A-Z]{2,5}\d{3,6}$/.test(code) && key) out.push({ code, offeringKey: key });
  }
  return out;
}

function syncUrl() {
  const parts = [];
  const q = els.search.value.trim();
  if (q) parts.push("q=" + encodeURIComponent(q));
  if (activeTimetable !== "Default Timetable") parts.push("t=" + encodeURIComponent(activeTimetable));
  const sel = currentSelection();
  if (sel.length) parts.push("s=" + encodeSelection(sel));
  const qs = parts.join("&");
  history.replaceState(null, "", qs ? `${location.pathname}?${qs}` : location.pathname);
}

// Apply ?q= / ?t= / ?s= from a shared link before the first render.
function readUrlParams() {
  const params = new URLSearchParams(location.search);
  const q = (params.get("q") || "").trim();
  if (q) els.search.value = q;
  const t = (params.get("t") || "").trim();
  if (t) {
    activeTimetable = t;
    if (!selection[t]) selection[t] = [];
  }
  const s = params.get("s");
  if (s) {
    const sel = decodeSelection(s);
    if (sel.length) selection[activeTimetable] = sel;
  }
}

// ---------------------------------------------------------------------------
// CSNL programme credit rules
// ---------------------------------------------------------------------------
// CSNL students may take at most 20 credits at Level 3 or below, and at most
// 15 credits from modules that aren't COMP coded. Shown alongside the clash
// warning, listing the exact modules that push past each limit.

const POLICY_MAX_LEVEL3 = 20; // credits at Level 3 or below
const POLICY_MAX_NON_COMP = 15; // credits from non-COMP modules

// The first digit of a code's number is UCD's module level (COMP30960 -> 3).
function moduleLevel(code) {
  const d = (String(code).match(/\d+/) || [""])[0];
  return d ? parseInt(d[0], 10) : 9;
}

function renderPolicyWarning() {
  const el = els.policyWarning;
  const seen = new Map(); // code -> info (each module once, not per offering)
  for (const s of currentSelection()) {
    if (!seen.has(s.code)) seen.set(s.code, moduleInfo(s.code));
  }
  const level3 = [];
  const nonComp = [];
  let l3Total = 0;
  let ncTotal = 0;
  for (const [code, info] of seen) {
    if (!info || !info.credits) continue;
    const lvl = moduleLevel(code);
    if (lvl <= 3) {
      l3Total += info.credits;
      level3.push({ code, credits: info.credits, level: lvl, title: info.title });
    }
    if (!code.startsWith("COMP")) {
      ncTotal += info.credits;
      nonComp.push({ code, credits: info.credits, title: info.title });
    }
  }
  const chip = (m) =>
    `<span class="policy-mod" title="${esc(m.title)}">${esc(m.code)}${m.level ? " · L" + m.level : ""} · ${m.credits} cr</span>`;
  const rules = [];
  if (l3Total > POLICY_MAX_LEVEL3) {
    rules.push(
      `<div class="policy-rule">` +
        `<strong>Level 3 or below: ${l3Total} / ${POLICY_MAX_LEVEL3} credits</strong> — ${l3Total - POLICY_MAX_LEVEL3} over the limit` +
        `<div class="policy-mods">${level3.map(chip).join("")}</div>` +
        `</div>`
    );
  }
  if (ncTotal > POLICY_MAX_NON_COMP) {
    rules.push(
      `<div class="policy-rule">` +
        `<strong>Non-COMP modules: ${ncTotal} / ${POLICY_MAX_NON_COMP} credits</strong> — ${ncTotal - POLICY_MAX_NON_COMP} over the limit` +
        `<div class="policy-mods">${nonComp.map(chip).join("")}</div>` +
        `</div>`
    );
  }
  if (!rules.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML =
    `<div class="policy-head">Your selection is over the CSNL programme credit limits:</div>` +
    `<div class="policy-note">Students may take no more than 20 credits at Level 3 or below, and no more than 15 credits from non-COMP modules.</div>` +
    rules.join("");
}

// ---------------------------------------------------------------------------
// timetable manager
// ---------------------------------------------------------------------------

function renderSwitcher() {
  els.timetableSwitcher.innerHTML = "";
  for (const name of Object.keys(selection)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === activeTimetable) opt.selected = true;
    els.timetableSwitcher.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// clash-free plan builder
// ---------------------------------------------------------------------------
// Suggests combinations of modules whose live timetables can coexist (no
// class clashes, using the same rules as the weekly timetable), close to a
// target credit total. Pure client-side over the already-fetched live data.

function planModuleSemesters(info, data) {
  // "1", "2", or "1, 2" from the catalogue; fall back to live trimesters
  const sem = (info && info.semester) || (data && data.semester) || "";
  if (sem) return sem.split(",").map((s) => s.trim()).filter(Boolean);
  const trims = (data && data.trimesters) || [];
  return trims.map((t) => (/autumn/i.test(t) ? "1" : /spring/i.test(t) ? "2" : null)).filter(Boolean);
}

function planPool(sem) {
  // Modules with live classes + known credits, matching the chosen semester
  const pool = [];
  for (const code of curatedCodes()) {
    const data = live.get(code);
    if (!data || !data.found || !data.classes || !data.classes.length) continue;
    const info = moduleInfo(code);
    const credits = info && info.credits ? info.credits : 0;
    if (!credits) continue;
    const sems = planModuleSemesters(info, data);
    if (sem !== "all" && sems.length && !sems.includes(sem)) continue;
    pool.push({ code, credits, info, data });
  }
  return pool;
}

// Can these two modules be taken together? There must be a class in each
// whose schedules don't overlap.
function modulesCompatible(a, b) {
  for (const ca of a.data.classes) {
    for (const cb of b.data.classes) {
      if (!classesClash(ca, cb)) return true;
    }
  }
  return false;
}

const PLAN_RESULTS = 6;
const PLAN_MAX_COMBOS = 6000;

function findPlans(target, sem) {
  const pool = planPool(sem);
  if (pool.length < 2) return [];
  pool.sort((a, b) => b.credits - a.credits);

  // suffix sums for credit-bound pruning
  const suffixMax = new Array(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) suffixMax[i] = suffixMax[i + 1] + pool[i].credits;

  const results = [];
  const combo = [];
  let explored = 0;
  const tolerance = 5; // accept totals within ±5 credits of the target

  function search(startIdx, total) {
    if (explored >= PLAN_MAX_COMBOS) return;
    explored++;
    if (combo.length >= 2) {
      const diff = Math.abs(total - target);
      if (diff <= tolerance) {
        results.push({ modules: combo.slice(), total, diff });
      }
    }
    for (let i = startIdx; i < pool.length; i++) {
      const m = pool[i];
      if (total + m.credits > target + tolerance) continue; // don't overshoot
      if (total + suffixMax[i] < target - tolerance) break; // can't reach the target
      let ok = true;
      for (const cm of combo) {
        if (!modulesCompatible(cm, m)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      combo.push(m);
      search(i + 1, total + m.credits);
      combo.pop();
    }
  }

  search(0, 0);
  results.sort((a, b) => a.diff - b.diff || a.modules.length - b.modules.length);
  return results.slice(0, PLAN_RESULTS);
}

function renderPlans() {
  const target = parseInt(els.planTarget.value, 10);
  const semChoice = els.planSemester.value;
  const sem = semChoice === "current" ? getCurrentSemester() || "1" : semChoice;
  const resultsEl = els.planResults;

  if (!target || target < 5) {
    resultsEl.innerHTML = `<p class="muted">Enter a target credit total (e.g. 30) to get suggestions.</p>`;
    return;
  }
  if (live.size < curatedCodes().length) {
    resultsEl.innerHTML = `<p class="muted">Timings are still loading — try again in a moment.</p>`;
    return;
  }

  const plans = findPlans(target, sem);
  const semLabel = sem === "1" ? "Semester 1" : sem === "2" ? "Semester 2" : "both semesters";

  if (!plans.length) {
    resultsEl.innerHTML = `<p class="muted">No clash-free ${semLabel} combinations found near ${target} credits yet.</p>`;
    return;
  }

  resultsEl.innerHTML = `<p class="plan-results-head">${plans.length} clash-free ${semLabel} plan${plans.length > 1 ? "s" : ""} near ${target} credits:</p>`;
  for (const plan of plans) {
    const item = document.createElement("div");
    item.className = "plan-item";
    const rows = plan.modules
      .map((m) => `<div class="plan-mod"><span class="plan-credits">${m.credits} cr</span> ${esc(m.info.title || m.code)} <span class="mono">${esc(m.code)}</span></div>`)
      .join("");
    const badge =
      plan.diff === 0
        ? `<span class="plan-badge exact">exact</span>`
        : `<span class="plan-badge">±${plan.diff}</span>`;
    item.innerHTML = `
      <div class="plan-item-head">
        <strong class="plan-total">${plan.total} credits</strong>
        ${badge}
        <button class="btn btn-ghost plan-use" data-plan="${esc(JSON.stringify(plan.modules.map((m) => m.code)))}">Use this plan</button>
      </div>
      <div class="plan-mods">${rows}</div>
    `;
    resultsEl.appendChild(item);
  }
}

function applyPlan(codes) {
  // Replace the current timetable's selection with a clash-free offering pick
  // for each module in the plan (greedy: take the first class that doesn't
  // clash with classes already picked).
  const picked = [];
  const sel = [];
  for (const code of codes) {
    const data = live.get(code);
    if (!data || !data.classes) continue;
    let chosen = null;
    for (const cls of data.classes) {
      if (!picked.some((p) => classesClash(p, cls))) {
        chosen = cls;
        break;
      }
    }
    if (!chosen) chosen = data.classes[0]; // fall back; clash warning will flag it
    picked.push(chosen);
    sel.push({ code, offeringKey: offeringKey(chosen) });
  }
  selection[activeTimetable] = sel;
  saveState();
  refreshUI();
  syncUrl();
  els.planResults.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

els.planBtn.addEventListener("click", renderPlans);
els.planTarget.addEventListener("keydown", (e) => {
  if (e.key === "Enter") renderPlans();
});
els.planResults.addEventListener("click", (e) => {
  const btn = e.target.closest(".plan-use");
  if (!btn) return;
  try {
    applyPlan(JSON.parse(btn.dataset.plan));
  } catch (err) {
    /* ignore malformed plans */
  }
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

els.search.addEventListener("input", () => {
  render();
  syncUrl();
});

els.courseList.addEventListener("change", (e) => {
  if (e.target.type === "checkbox" && e.target.dataset.code) {
    toggleOffering(e.target.dataset.code, e.target.dataset.key, e.target.checked);
  }
});

els.courseList.addEventListener("click", (e) => {
  const toggle = e.target.closest(".theme-toggle");
  if (toggle) {
    const body = toggle.nextElementSibling;
    const collapsed = toggle.classList.contains("collapsed");
    for (const t of document.querySelectorAll(".theme-toggle")) {
      if (t !== toggle) {
        t.classList.add("collapsed");
        t.nextElementSibling.classList.add("hidden");
      }
    }
    toggle.classList.toggle("collapsed", !collapsed);
    body.classList.toggle("hidden", !collapsed);
  }
});

els.summaryList.addEventListener("click", (e) => {
  const btn = e.target.closest(".s-x");
  if (!btn) return;
  const code = btn.dataset.code;
  selection[activeTimetable] = currentSelection().filter((s) => s.code !== code);
  saveState();
  refreshUI();
  syncUrl();
});

els.addTimetableBtn.addEventListener("click", () => {
  const name = els.newTimetableName.value.trim();
  if (name && !(name in selection)) {
    selection[name] = [];
    activeTimetable = name;
    els.newTimetableName.value = "";
    saveState();
    refreshUI();
    syncUrl();
  }
});

els.timetableSwitcher.addEventListener("change", (e) => {
  activeTimetable = e.target.value;
  saveState();
  refreshUI();
  syncUrl();
});

els.deleteTimetableBtn.addEventListener("click", () => {
  if (Object.keys(selection).length <= 1) return;
  if (!confirm(`Delete “${activeTimetable}” and its selection? This can't be undone.`)) return;
  delete selection[activeTimetable];
  activeTimetable = Object.keys(selection)[0];
  saveState();
  refreshUI();
  syncUrl();
});

els.clearBtn.addEventListener("click", () => {
  const n = currentSelection().length;
  if (n === 0) return;
  if (!confirm(`Clear all ${n} selected classes from “${activeTimetable}”? This can't be undone.`)) return;
  selection[activeTimetable] = [];
  saveState();
  refreshUI();
  syncUrl();
});

els.refreshBtn.addEventListener("click", () => {
  setLoadingStatus("Refreshing timings from UCD…");
  fetchAllTimings(true).catch((e) => setErrorStatus(`Refresh failed: ${e.message}`));
});

els.printBtn.addEventListener("click", () => window.print());
// Re-render the events with the print stylesheet's compact grid metrics
// (read from the CSS variables), then restore the screen layout.
window.addEventListener("beforeprint", () => renderTimetable());
window.addEventListener("afterprint", () => renderTimetable());

// Inline error next to the add-by-code field (kept in sync with aria-describedby).
function showAddCodeError(msg) {
  els.addCodeError.textContent = msg || "";
  els.addCodeError.hidden = !msg;
}

// Every CSNL module is already listed, so a valid code just jumps to its card.
function revealModule(code) {
  els.search.value = "";
  render();
  syncUrl();
  const card = document.querySelector(`.course-card[data-code="${CSS.escape(code)}"]`);
  if (!card) return;
  const toggle = card.closest(".theme") && card.closest(".theme").querySelector(".theme-toggle");
  if (toggle) {
    toggle.classList.remove("collapsed");
    toggle.nextElementSibling.classList.remove("hidden");
  }
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1500);
  card.scrollIntoView({ behavior: "smooth", block: "center" });
}

function addModuleByCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return; // empty field — nothing to do
  if (!/^[A-Z]{2,5}\d{3,6}$/.test(code)) {
    showAddCodeError(`“${esc(rawCode || "")}” doesn't look like a module code — try e.g. COMP30960`);
    els.addCodeInput.focus();
    return;
  }
  if (!curatedCodes().includes(code)) {
    // the picker only offers — and only fetches — modules from the CSNL list
    showAddCodeError(
      `${code} isn't on the CSNL module list — only modules from UCD's CSNL streams page can be added.`
    );
    els.addCodeInput.focus();
    return;
  }
  els.addCodeInput.value = "";
  showAddCodeError("");
  revealModule(code);
}

els.addCodeBtn.addEventListener("click", () => addModuleByCode(els.addCodeInput.value));
els.addCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addModuleByCode(els.addCodeInput.value);
});
els.addCodeInput.addEventListener("input", () => showAddCodeError(""));

els.courseList.addEventListener("click", (e) => {
  const retry = e.target.closest(".retry-module");
  if (retry) {
    retryModule(retry.dataset.code);
    return;
  }
});

// Suggestions — posts to Netlify Forms via AJAX (no page reload). In
// production Netlify intercepts the POST at "/"; the local dev server logs
// the submission instead.
els.suggestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!els.suggestText.value.trim()) {
    els.suggestError.textContent = "Write a suggestion before sending.";
    els.suggestError.hidden = false;
    els.suggestText.focus();
    return;
  }
  els.suggestError.hidden = true;
  els.suggestSubmit.disabled = true;
  els.suggestSubmit.textContent = "Sending…";
  try {
    // URL-encoded (not multipart) — this is the AJAX shape Netlify Forms accepts
    const res = await fetch("/", {
      method: "POST",
      body: new URLSearchParams(new FormData(els.suggestForm)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    els.suggestForm.reset();
    els.suggestDone.classList.remove("hidden");
  } catch (err) {
    els.suggestError.textContent = "Couldn't send your suggestion — check your connection and try again.";
    els.suggestError.hidden = false;
  } finally {
    els.suggestSubmit.disabled = false;
    els.suggestSubmit.textContent = "Send suggestion";
  }
});
// hide the success note again once the visitor starts typing a new one
els.suggestForm.addEventListener("input", () => els.suggestDone.classList.add("hidden"));

// The picker only offers modules from the CSNL streams list — drop anything
// else (codes added before this restriction, stale cache entries, selections)
// so no non-CSNL module is ever fetched or shown.
function purgeNonCsnl() {
  const csnl = new Set(curatedCodes());
  for (const name of Object.keys(selection)) {
    const sel = selection[name].filter((s) => csnl.has(s.code));
    if (sel.length !== selection[name].length) selection[name] = sel;
  }
  for (const code of [...live.keys()]) if (!csnl.has(code)) live.delete(code);
  saveState();
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

let autoRefreshing = false;
let lastAutoRefresh = 0;

// Periodic background refresh so timings stay current without the manual
// button. Skips when a refresh is already running, the tab is hidden, or
// we refreshed moments ago (background-tab timers get throttled, so the
// visibility handler catches up when the tab is shown again).
async function autoRefresh() {
  if (autoRefreshing || document.hidden) return;
  if (Date.now() - lastAutoRefresh < AUTO_REFRESH_MS) return;
  autoRefreshing = true;
  try {
    setLoadingStatus("Refreshing live timings…");
    await fetchAllTimings(false, true); // respect the server cache; updates the browser cache too
    lastAutoRefresh = Date.now();
  } catch (e) {
    setErrorStatus(`Auto-refresh failed: ${e.message}`);
  } finally {
    autoRefreshing = false;
  }
}

function startAutoRefresh() {
  setInterval(autoRefresh, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) autoRefresh();
  });
}

(async function init() {
  loadState();
  readUrlParams();
  initTheme();
  setAppInert(true);
  try {
    // Prefer the catalogue service (it auto-refreshes the module list each
    // 1 August); fall back to the committed modules.json if it's unavailable.
    let data = null;
    try {
      const res = await fetch(CATALOGUE_URL);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json)) {
          data = json;
        } else {
          data = json.themes;
          catalogueMeta = {
            verified: !!json.verified,
            pageUpdated: json.pageUpdated,
            year: json.year,
          };
        }
      }
    } catch (e) {
      /* fall through to modules.json */
    }
    if (!data) {
      const res = await fetch("modules.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      // committed fallback — CSNL-only but not live-verified this load
      catalogueMeta = { verified: false, pageUpdated: null, year: null };
    }
    for (const t of data) {
      const courses = t.courses.map((c) => ({ ...c, ...parseName(c.name) }));
      catalogue.push({ theme: t.theme, courses });
    }
    updateCsnlBadge();
  } catch (e) {
    setErrorStatus("Could not load module list");
    failBoot("Could not load the module list.");
    return;
  }

  createGrid();

  // Restore saved timetables from the browser cache so the page is usable
  // instantly on repeat visits, then refresh from UCD in the background.
  const cachedCount = loadTimingsCache();
  purgeNonCsnl();
  refreshUI();
  if (cachedCount > 0) {
    els.bootSub.textContent = `Restored ${cachedCount} saved timetables — refreshing from UCD…`;
    els.bootCountText.textContent = `${cachedCount} cached modules`;
    els.bootFill.style.width = "100%";
    els.bootPercent.textContent = "100%";
    finishBoot();
    setLoadingStatus("Refreshing live timings from UCD…");
    try {
      await fetchAllTimings(false, true);
    } catch (e) {
      setErrorStatus(`Refresh failed: ${e.message}`);
    }
  } else {
    setLoadingStatus("Fetching live timings from UCD…");
    try {
      await fetchAllTimings(false);
      finishBoot();
    } catch (e) {
      setErrorStatus(`Failed to fetch timings: ${e.message}`);
      failBoot(`Could not load timings: ${e.message}`);
    }
  }

  // Keep timings current from here on; also self-heals a failed initial load.
  lastAutoRefresh = Date.now();
  startAutoRefresh();
})();
