// CSNL Module Picker — live timings from UCD, refreshed on every page load.

"use strict";

const FUNCTION_URL = "/.netlify/functions/timetable";
const BATCH_SIZE = 14; // modules per function call
const PARALLEL_BATCHES = 2; // function calls run at once
// UCD's timetable uses Tue/Thu abbreviations
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };
const HOUR_START = 8;
const HOUR_HEIGHT = 52;

const LS_SELECTION = "csnlPicker:selection:v1";
const LS_ACTIVE = "csnlPicker:active:v1";
const LS_EXTRA = "csnlPicker:extraCodes:v1";
const LS_THEME = "csnlPicker:theme:v1";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const catalogue = []; // curated [{ theme, courses: [{ title, code, credits }] }]
const live = new Map(); // code -> timetable payload from the function
let selection = {}; // timetableName -> [{ code, offeringKey }]
let activeTimetable = "Default Timetable";
let moduleCount = 0;
let extraCodes = []; // user-added module codes (persisted; timings always live)

// ---------------------------------------------------------------------------
// dom refs
// ---------------------------------------------------------------------------

const els = {
  courseList: document.getElementById("course-list"),
  search: document.getElementById("search"),
  moduleCount: document.getElementById("module-count"),
  statusPill: document.getElementById("status-pill"),
  statusDot: document.getElementById("status-dot"),
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
  clashWarning: document.getElementById("clash-warning"),
  addCodeInput: document.getElementById("add-code-input"),
  addCodeBtn: document.getElementById("add-code-btn"),
  themeToggle: document.getElementById("theme-toggle"),
  bootScreen: document.getElementById("boot-screen"),
  bootFill: document.getElementById("boot-fill"),
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
  // "Introduction to Cognitive Science (Graduate) (COMP47230)" -> COMP47230
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
  try {
    const e = JSON.parse(localStorage.getItem(LS_EXTRA) || "[]");
    if (Array.isArray(e)) extraCodes = e.map((s) => String(s).toUpperCase()).filter(Boolean);
  } catch (err) {
    /* ignore */
  }
  if (!selection[activeTimetable]) selection[activeTimetable] = [];
}

function saveState() {
  localStorage.setItem(LS_SELECTION, JSON.stringify(selection));
  localStorage.setItem(LS_ACTIVE, activeTimetable);
}

// deterministic per-module hue; the CSS turns it into theme-aware event colors
function hueFor(code) {
  let hash = 0;
  for (const ch of code) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
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

async function fetchAllTimings(fresh) {
  const codes = [];
  for (const code of allCodes()) if (!live.has(code)) codes.push(code);

  if (codes.length === 0 && !fresh) return;

  const toFetch = fresh ? allCodes() : codes;
  const total = toFetch.length;
  let done = 0;

  const progressEl = els.progress;
  progressEl.classList.remove("hidden");

  const setProgress = () => {
    const pct = Math.round((done / total) * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressText.textContent = `Fetching live timetables from UCD… ${done}/${total}`;
    els.bootFill.style.width = `${pct}%`;
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
          live.set(code, { found: false, reason: `Fetch error: ${e.message}` });
        }
      } finally {
        done += batch.length;
        setProgress();
        refreshUI();
      }
    }
  });

  await Promise.all(workers);
  progressEl.classList.add("hidden");
  refreshUI();
  updateStatus();
}

function updateStatus() {
  const liveCount = [...live.values()].filter((d) => d.found && d.classes && d.classes.length).length;
  const total = allCodes().length;
  const ts = new Date();
  const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  els.statusPill.classList.remove("loading", "error");
  els.statusText.textContent = `Live UCD timings · ${liveCount}/${total} modules · updated ${time}`;
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

function curatedCodes() {
  const codes = [];
  for (const t of catalogue) for (const c of t.courses) codes.push(c.code);
  return codes;
}

function allCodes() {
  return [...new Set([...curatedCodes(), ...extraCodes])];
}

function moduleInfo(code) {
  for (const t of catalogue)
    for (const c of t.courses) if (c.code === code) return c;
  // user-added module: no curated metadata, everything comes from UCD
  return { code, title: (live.get(code) || {}).title || code, credits: null, extra: true };
}

function refreshUI() {
  render();
  renderSummary();
  renderSwitcher();
  renderTimetable();
}

function render() {
  const term = els.search.value.toLowerCase().trim();
  const list = els.courseList;
  list.innerHTML = "";

  const themes = catalogue.map((t) => ({
    name: t.theme,
    courses: t.courses.filter(
      (c) =>
        !term ||
        liveTitle(c.code).toLowerCase().includes(term) ||
        c.code.toLowerCase().includes(term)
    ),
  }));
  const extraCourses = extraCodes
    .filter((code) => !curatedCodes().includes(code))
    .filter(
      (code) =>
        !term ||
        liveTitle(code).toLowerCase().includes(term) ||
        code.toLowerCase().includes(term)
    )
    .map((code) => ({ code }));
  if (extraCourses.length) themes.push({ name: "My Modules", courses: extraCourses });

  let shown = 0;
  for (const themeObj of themes) {
    if (themeObj.courses.length === 0) continue;
    shown += themeObj.courses.length;

    const section = document.createElement("div");
    section.className = "theme";
    section.innerHTML = `
      <button class="theme-toggle collapsed">
        <span>${esc(themeObj.name)}<span class="theme-count">${themeObj.courses.length}</span></span>
        <span class="chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </button>
      <div class="theme-body hidden"></div>
    `;
    const body = section.querySelector(".theme-body");
    for (const c of themeObj.courses) body.appendChild(renderCourseCard(c));
    list.appendChild(section);
  }

  if (shown === 0) {
    list.innerHTML = `<p class="empty">No modules found matching “${esc(term)}”.</p>`;
  }
  els.moduleCount.textContent = `${shown} modules`;
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

  const badges = [];
  if (data && data.semester) {
    badges.push(data.semester === "1, 2" ? "Both semesters" : "Semester " + data.semester);
  }
  if (c.credits) badges.push(`${c.credits} cr`);
  if (data && data.found && data.year) {
    const terms =
      data.trimesters && data.trimesters.length > 1
        ? data.trimesters.join(" + ")
        : data.trimester || "";
    badges.push(`${data.year} · ${terms}`.trim());
  }

  card.innerHTML = `
    <div class="card-top">
      <div>
        <h3><a class="module-link" href="${UCD_MODULE_BASE}${esc(c.code)}" target="_blank" rel="noopener" title="View ${esc(c.code)} on ucd.ie">${esc(liveTitle(c.code))}</a></h3>
        <div class="badges">
          ${badges.map((b) => `<span class="badge${data && data.found ? " live" : ""}">${esc(b)}</span>`).join("")}
        </div>
      </div>
      <div class="card-code-col">
        <span class="badge">${esc(c.code)}</span>
        ${c.extra ? `<button class="remove-extra-btn" data-code="${esc(c.code)}" title="Remove from list" aria-label="Remove ${esc(c.code)} from list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` : ""}
      </div>
    </div>
    <div class="offerings" data-code="${esc(c.code)}"></div>
  `;

  const offeringsEl = card.querySelector(".offerings");
  if (!data) {
    offeringsEl.innerHTML = `<div class="note loading">Loading live timetable…</div>`;
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

    const start = timeToMinutes(cls.startTime);
    const end = timeToMinutes(cls.endTime);
    const top = (start / 60 - HOUR_START) * HOUR_HEIGHT + 38;
    const height = ((end - start) / 60) * HOUR_HEIGHT;
    const dayIndex = DAY_INDEX[cls.day];
    if (!dayIndex) continue;

    const el = document.createElement("div");
    el.className = "timetable-event";
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(height, 18)}px`;
    el.style.left = `calc(56px + ${dayIndex - 1} * ((100% - 56px) / 5) + 2px)`;
    el.style.width = `calc((100% - 56px) / 5 - 4px)`;
    el.style.setProperty("--ev-hue", hueFor(s.code));
    el.innerHTML = `
      <div class="ev-title">${esc(info.title)}</div>
      <div class="ev-time">${esc(cls.typeLabel)} · ${esc(cls.startTime)}–${esc(cls.endTime)}</div>
    `;
    events.push({ el, cls });
  }

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i].cls;
      const b = events[j].cls;
      if (a.day !== b.day) continue;
      const s1 = timeToMinutes(a.startTime);
      const e1 = timeToMinutes(a.endTime);
      const s2 = timeToMinutes(b.startTime);
      const e2 = timeToMinutes(b.endTime);
      if (Math.max(s1, s2) < Math.min(e1, e2)) {
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
// events
// ---------------------------------------------------------------------------

els.search.addEventListener("input", render);

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
});

els.addTimetableBtn.addEventListener("click", () => {
  const name = els.newTimetableName.value.trim();
  if (name && !(name in selection)) {
    selection[name] = [];
    activeTimetable = name;
    els.newTimetableName.value = "";
    saveState();
    refreshUI();
  }
});

els.timetableSwitcher.addEventListener("change", (e) => {
  activeTimetable = e.target.value;
  saveState();
  refreshUI();
});

els.deleteTimetableBtn.addEventListener("click", () => {
  if (Object.keys(selection).length <= 1) return;
  delete selection[activeTimetable];
  activeTimetable = Object.keys(selection)[0];
  saveState();
  refreshUI();
});

els.clearBtn.addEventListener("click", () => {
  selection[activeTimetable] = [];
  saveState();
  refreshUI();
});

els.refreshBtn.addEventListener("click", () => {
  setLoadingStatus("Refreshing timings from UCD…");
  fetchAllTimings(true).catch((e) => setErrorStatus(`Refresh failed: ${e.message}`));
});

function persistExtraCodes() {
  localStorage.setItem(LS_EXTRA, JSON.stringify(extraCodes));
}

async function addModuleByCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2,5}\d{3,6}$/.test(code)) {
    setErrorStatus(`“${esc(rawCode || "")}” doesn't look like a module code (e.g. COMP30960)`);
    return;
  }
  if (!extraCodes.includes(code) && !curatedCodes().includes(code)) {
    extraCodes.push(code);
    persistExtraCodes();
    els.addCodeInput.value = "";
    // fetch just this module live, then re-render
    setLoadingStatus(`Fetching ${code} from UCD…`);
    try {
      const json = await fetchBatch([code], false);
      for (const [c, d] of Object.entries(json.results || {})) {
        live.set(c, { ...d, fetchedAt: json.generatedAt });
      }
    } catch (e) {
      setErrorStatus(`Could not fetch ${code}: ${e.message}`);
    }
    updateStatus();
    refreshUI();
  } else {
    els.addCodeInput.value = "";
    refreshUI();
  }
}

els.addCodeBtn.addEventListener("click", () => addModuleByCode(els.addCodeInput.value));
els.addCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addModuleByCode(els.addCodeInput.value);
});

els.courseList.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove-extra-btn");
  if (!btn) return;
  const code = btn.dataset.code;
  extraCodes = extraCodes.filter((c) => c !== code);
  persistExtraCodes();
  // drop its selected classes too
  for (const name of Object.keys(selection)) {
    selection[name] = selection[name].filter((s) => s.code !== code);
  }
  live.delete(code);
  saveState();
  refreshUI();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function renderAll() {
  refreshUI();
}

(async function init() {
  loadState();
  initTheme();
  setAppInert(true);
  try {
    const res = await fetch("modules.json");
    const data = await res.json();
    for (const t of data) {
      const courses = t.courses.map((c) => ({ ...c, ...parseName(c.name) }));
      catalogue.push({ theme: t.theme, courses });
    }
    moduleCount = allCodes().length;
  } catch (e) {
    setErrorStatus("Could not load module list");
    failBoot("Could not load the module list.");
    return;
  }

  createGrid();
  renderAll();
  setLoadingStatus("Fetching live timings from UCD…");
  try {
    await fetchAllTimings(false);
    finishBoot();
  } catch (e) {
    setErrorStatus(`Failed to fetch timings: ${e.message}`);
    failBoot(`Could not load timings: ${e.message}`);
  }
})();
