// Test harness for the live UCD timetable data.
//
//   node tools/test-timetables.js [--fresh]
//
// Fetches the catalogue + every module's live timetable through the local
// server (http://localhost:8787), then runs the same logic the frontend uses
// (offeringKey / normalizeTimetable / classesClash / clashFreeAssignment /
// findPlans) against every combination of modules:
//
//   1. Data-quality checks (target year, clean term codes, no garbage types)
//   2. Every module pair — can both be taken together, and which pairs can
//      never coexist?
//   3. Internal clashes within a single module's own classes
//   4. The clash-free plan builder (findPlans) for several targets and
//      semesters — every returned plan must be genuinely clash-free
//
// Start the server first:  node server.js

"use strict";

const BASE = "http://localhost:8787";

// --- app.js logic, replicated exactly --------------------------------------

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function offeringKey(cls) {
  return `${cls.day}|${cls.startTime}|${cls.type}|${cls.offering}`;
}

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function normDate(s) {
  const m = String(s).match(/^(\d{2}) (\w{3}) (\d{4})$/);
  if (!m) return String(s);
  return m[3] + "-" + (MONTHS[m[2]] || "00") + "-" + m[1];
}

function normalizeTimetable(data) {
  if (!data || !Array.isArray(data.classes) || data.classes.length < 2) return data;
  const byKey = new Map();
  for (const cls of data.classes) {
    const key = offeringKey(cls);
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, { ...cls, weeks: [...cls.weeks] });
      continue;
    }
    g.weeks = [...new Set(g.weeks.concat(cls.weeks))].sort((a, b) => a - b);
    g.term = unionTerms(g, cls);
    if (normDate(cls.firstDate) < normDate(g.firstDate)) g.firstDate = cls.firstDate;
    if (normDate(cls.lastDate) > normDate(g.lastDate)) g.lastDate = cls.lastDate;
  }
  return { ...data, classes: [...byKey.values()] };
}

// Merge two classes' semester info ("1" + "2" -> "1, 2").
function unionTerms(a, b) {
  const set = new Set(classTerms(a).concat(classTerms(b)));
  if (!set.size) return null;
  return [...set].sort().join(", ");
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// The trimester(s) a class runs in ("1", "2", "1, 2"), set by the proxy from
// the class's week numbers (UCD: Autumn weeks 1-12, Spring weeks 20-33).
// Falls back to deriving the term from the weeks themselves (the proxy's own
// rule: <=12 Autumn, >=13 Spring), which keeps the semester-aware clash rule
// working even against cached payloads that predate the term field.
function classTerms(cls) {
  if (!cls) return [];
  if (cls.term) {
    return cls.term.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (cls.weeks && cls.weeks.length) {
    const hasAutumn = cls.weeks.some((w) => w <= 12);
    const hasSpring = cls.weeks.some((w) => w >= 13);
    if (hasAutumn && hasSpring) return ["1", "2"];
    if (hasAutumn) return ["1"];
    if (hasSpring) return ["2"];
  }
  return [];
}

function classesClash(a, b) {
  if (!a || !b || a.day !== b.day) return false;
  // Classes in disjoint trimesters can never run at the same time (Autumn
  // weeks 1-12 vs Spring weeks 20-33 share no week), so they never clash.
  const ta = classTerms(a);
  const tb = classTerms(b);
  if (ta.length && tb.length && !ta.some((t) => tb.includes(t))) return false;
  const s1 = timeToMinutes(a.startTime);
  const e1 = timeToMinutes(a.endTime);
  const s2 = timeToMinutes(b.startTime);
  const e2 = timeToMinutes(b.endTime);
  if (Math.max(s1, s2) >= Math.min(e1, e2)) return false;
  const wa = a.weeks && a.weeks.length ? a.weeks : null;
  const wb = b.weeks && b.weeks.length ? b.weeks : null;
  if (wa && wb) return wa.some((w) => wb.includes(w));
  return true;
}

function moduleLevel(code) {
  const d = (String(code).match(/\d+/) || [""])[0];
  return d ? parseInt(d[0], 10) : 9;
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

// Picks one class per module so that no two clash, or null if impossible.
function clashFreeAssignment(mods) {
  const groups = mods.map((m) => m.data.classes);
  const chosen = [];
  function tryAssign(i) {
    if (i === groups.length) return true;
    for (const cls of groups[i]) {
      if (!chosen.some((c) => classesClash(c, cls))) {
        chosen.push(cls);
        if (tryAssign(i + 1)) return true;
        chosen.pop();
      }
    }
    return false;
  }
  return tryAssign(0) ? chosen : null;
}

// --- fetch helpers ---------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function codeFromName(name) {
  const m = String(name).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim().toUpperCase() : name.toUpperCase();
}

// --- checks ----------------------------------------------------------------

function qualityChecks(results, targetYear) {
  const problems = [];
  for (const [code, d] of Object.entries(results)) {
    if (d.found === false) continue;
    if (Array.isArray(d.classes) && d.classes.length) {
      if (d.year !== targetYear) {
        problems.push(`${code}: served year ${d.year}, expected ${targetYear}`);
      }
      for (const cls of d.classes) {
        if (cls.termCode && /\s/.test(String(cls.termCode))) {
          problems.push(`${code}: multi-value termCode ${JSON.stringify(cls.termCode)}`);
        }
        if (cls.crn && /\s/.test(String(cls.crn))) {
          problems.push(`${code}: multi-value crn ${JSON.stringify(cls.crn)}`);
        }
        if (!DAYS.includes(cls.day)) {
          problems.push(`${code}: unknown day ${JSON.stringify(cls.day)}`);
        }
        if (!/^\d{1,2}:\d{2}$/.test(String(cls.startTime)) || !/^\d{1,2}:\d{2}$/.test(String(cls.endTime))) {
          problems.push(`${code}: bad time ${cls.startTime}-${cls.endTime}`);
        }
        if (cls.lengthMins <= 0) {
          problems.push(`${code}: non-positive length ${cls.lengthMins}`);
        }
      }
    }
  }
  return problems;
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  const q = fresh ? "&fresh=1" : "";

  console.log("Fetching catalogue…");
  const cat = await getJson(`${BASE}/.netlify/functions/catalogue`);
  const themes = Array.isArray(cat) ? cat : cat.themes;
  const all = [];
  for (const t of themes) {
    for (const c of t.courses) {
      const code = codeFromName(c.name);
      if (!all.some((x) => x.code === code)) {
        all.push({ code, title: c.name.replace(/\s*\([^)]*\)\s*$/, ""), credits: c.credits, semester: c.semester, kind: c.kind });
      }
    }
  }
  const codes = all.map((m) => m.code);
  console.log(`Catalogue: ${codes.length} modules, target year ${cat.year || "?"}`);

  const results = {};
  const errors = {};
  for (let i = 0; i < codes.length; i += 20) {
    const batch = codes.slice(i, i + 20);
    const json = await getJson(`${BASE}/.netlify/functions/timetable?codes=${encodeURIComponent(batch.join(","))}${q}`);
    Object.assign(results, json.results || {});
    Object.assign(errors, json.errors || {});
  }
  const bad = Object.keys(errors);
  if (bad.length) console.log(`Fetch errors: ${bad.join(", ")}`);

  const live = new Map();
  for (const code of codes) {
    const d = results[code];
    if (d) live.set(code, normalizeTimetable(d));
    else live.set(code, { found: false, reason: "missing" });
  }

  // ---- 1. data quality
  const targetYear = `${cat.year}/${String((cat.year + 1) % 100).padStart(2, "0")}`;
  const problems = qualityChecks(results, targetYear);
  console.log(`\n[1] Data quality (target year ${targetYear}):`);
  if (problems.length) {
    console.log(`  FAIL — ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.log(`    - ${p}`);
  } else {
    console.log("  OK — all served timetables are for the target year with clean term codes/CRNs");
  }

  // ---- 2. pairwise combination test
  console.log("\n[2] Every module pair (every subject × every subject):");
  const withClasses = all.filter((m) => live.get(m.code) && live.get(m.code).classes && live.get(m.code).classes.length);
  const byCode = new Map(withClasses.map((m) => [m.code, { ...m, data: live.get(m.code) }]));
  let pairs = 0;
  const impossible = [];
  for (let i = 0; i < withClasses.length; i++) {
    for (let j = i + 1; j < withClasses.length; j++) {
      pairs++;
      const a = byCode.get(withClasses[i].code);
      const b = byCode.get(withClasses[j].code);
      if (!modulesCompatible(a, b)) {
        impossible.push(`${a.code} (${a.title}) × ${b.code} (${b.title})`);
      }
    }
  }
  console.log(`  ${pairs} pairs checked — ${impossible.length} can never be taken together (no clash-free assignment exists).`);
  for (const p of impossible) console.log(`    - ${p}`);
  if (!impossible.length) console.log("  OK — every pair of modules can coexist in some offering combination.");

  // ---- 3. internal clashes within a module's own classes
  console.log("\n[3] Internal clashes (a module's own classes overlapping):");
  let internal = 0;
  for (const m of withClasses) {
    const cls = live.get(m.code).classes;
    for (let i = 0; i < cls.length; i++) {
      for (let j = i + 1; j < cls.length; j++) {
        if (classesClash(cls[i], cls[j])) {
          internal++;
          console.log(`  - ${m.code}: ${cls[i].type} ${cls[i].day} ${cls[i].startTime} × ${cls[j].type} ${cls[j].day} ${cls[j].startTime}`);
        }
      }
    }
  }
  if (!internal) console.log("  OK — no module has internally clashing classes.");

  // ---- 4. plan builder
  console.log("\n[4] Clash-free plan builder:");
  const POLICY_MAX_LEVEL3 = 20;
  const POLICY_MAX_NON_COMP = 15;
  function planViolatesPolicy(modules) {
    let l3 = 0;
    let nonComp = 0;
    for (const m of modules) {
      if (moduleLevel(m.code) <= 3) l3 += m.credits;
      if (!String(m.code).startsWith("COMP")) nonComp += m.credits;
    }
    return l3 > POLICY_MAX_LEVEL3 || nonComp > POLICY_MAX_NON_COMP;
  }
  function planPool(sem) {
    const pool = [];
    for (const m of all) {
      const data = live.get(m.code);
      if (!data || !data.found || !data.classes || !data.classes.length) continue;
      const credits = m.credits || 0;
      if (!credits) continue;
      const sems = String(m.semester || (data && data.semester) || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (sem !== "all" && sems.length && !sems.includes(sem)) continue;
      pool.push({ code: m.code, credits, semester: m.semester || (data && data.semester) || "", info: { title: m.title, credits }, data });
    }
    return pool;
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function findPlans(target, sem, maxCombos) {
    const pool = planPool(sem);
    if (pool.length < 2) return [];
    const tolerance = 5;
    const found = new Map();
    const cfaMemo = new Map();
    const n = pool.length;
    const compatMat = Array.from({ length: n }, () => new Array(n).fill(false));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) compatMat[i][j] = compatMat[j][i] = modulesCompatible(pool[i], pool[j]);
    function addPlan(mods) {
      if (mods.length < 2) return;
      const total = mods.reduce((s, m) => s + m.credits, 0);
      if (Math.abs(total - target) > tolerance) return;
      if (planViolatesPolicy(mods)) return;
      // A "Both semesters" plan must actually span both (mirrors app.js).
      if (sem === "all") {
        const hasS1 = mods.some((m) => String(m.semester || "").includes("1"));
        const hasS2 = mods.some((m) => String(m.semester || "").includes("2"));
        if (!hasS1 || !hasS2) return;
      }
      const key = mods.map((m) => m.code).sort().join(",");
      if (found.has(key)) return;
      if (!cfaMemo.has(key)) cfaMemo.set(key, !!clashFreeAssignment(mods));
      if (!cfaMemo.get(key)) return;
      found.set(key, { modules: mods.slice(), total, diff: Math.abs(total - target) });
    }
    for (let r = 0; r < 6; r++) {
      if (found.size >= 6) break;
      const order = r === 0 ? [...pool].sort((a, b) => b.credits - a.credits) : shuffle([...pool]);
      if (target <= 45) {
        const suffixMax = new Array(order.length + 1).fill(0);
        for (let i = order.length - 1; i >= 0; i--) suffixMax[i] = suffixMax[i + 1] + order[i].credits;
        const combo = [];
        let explored = 0;
        function search(startIdx, total) {
          if (found.size >= 6) return;
          if (explored >= maxCombos) return;
          explored++;
          if (combo.length >= 2 && Math.abs(total - target) <= tolerance) addPlan(combo);
          for (let i = startIdx; i < order.length; i++) {
            const m = order[i];
            if (total + m.credits > target + tolerance) continue;
            if (total + suffixMax[i] < target - tolerance) break;
            let ok = true;
            for (const cm of combo) if (!compatMat[pool.indexOf(cm)][pool.indexOf(m)]) { ok = false; break; }
            if (!ok) continue;
            combo.push(m);
            search(i + 1, total + m.credits);
            combo.pop();
          }
        }
        search(0, 0);
      }
      for (let a = 0; a < Math.ceil(900 / 6); a++) {
        if (found.size >= 6) break;
        const ord = shuffle([...pool]);
        const cap = target + tolerance - Math.floor(Math.random() * (tolerance + 1));
        const g = [];
        let gt = 0;
        for (const m of ord) {
          if (gt + m.credits > cap) continue;
          let ok = true;
          for (const cm of g) if (!compatMat[pool.indexOf(cm)][pool.indexOf(m)]) { ok = false; break; }
          if (!ok) continue;
          g.push(m);
          gt += m.credits;
        }
        addPlan(g);
      }
    }
    const results = [...found.values()].sort((a, b) => a.diff - b.diff || a.modules.length - b.modules.length);
    return results.slice(0, 6);
  }

  let planFails = 0;
  let planChecks = 0;
  for (const target of [30, 60, 90]) {
    for (const sem of ["1", "2", "all"]) {
      const t0 = Date.now();
      const plans = findPlans(target, sem, 4000);
      const elapsed = Date.now() - t0;
      planChecks++;
      const label = `${target}cr sem=${sem}`;
      if (!plans.length) {
        console.log(`  ${label}: no plans found (${elapsed}ms) — not a failure, but flag if plans are expected`);
        continue;
      }
      // verify every plan is genuinely clash-free AND policy-clean (and, for
      // the "all" target, that it actually spans both semesters)
      let ok = true;
      for (const plan of plans) {
        const mods = plan.modules.map((m) => ({ code: m.code, data: m.data }));
        if (!clashFreeAssignment(mods)) { ok = false; planFails++; }
        if (planViolatesPolicy(plan.modules)) { ok = false; planFails++; }
        if (sem === "all") {
          const sems = plan.modules.map((m) => String(m.semester || ""));
          if (!sems.some((s) => s.includes("1")) || !sems.some((s) => s.includes("2"))) {
            ok = false;
            planFails++;
          }
        }
      }
      console.log(`  ${label}: ${plans.length} plan(s) in ${elapsed}ms — ${ok ? "OK, all genuinely clash-free and policy-clean" : "FAIL (contains a clashing or policy-violating plan)"}`);
      for (const p of plans.slice(0, 2)) {
        console.log(`      ${p.total}cr ${p.modules.map((m) => m.code).join(" + ")}`);
      }
    }
  }
  if (planFails) console.log(`  FAIL — ${planFails} plan(s) were not clash-free`);
  else console.log("  OK — every suggested plan is genuinely clash-free and within CSNL credit rules.");

  // ---- 5. cross-semester separation
  console.log("\n[5] Cross-semester separation (same slot, different semesters):");
  const allClasses = [];
  for (const m of withClasses) {
    for (const cl of live.get(m.code).classes) allClasses.push({ code: m.code, cls: cl });
  }
  let crossSem = 0;
  for (let i = 0; i < allClasses.length; i++) {
    for (let j = i + 1; j < allClasses.length; j++) {
      const A = allClasses[i];
      const B = allClasses[j];
      if (A.code === B.code) continue; // a module's own classes are covered in [3]
      const ta = classTerms(A.cls);
      const tb = classTerms(B.cls);
      if (!ta.length || !tb.length) continue;
      if (!ta.some((t) => tb.includes(t)) && classesClash(A.cls, B.cls)) {
        crossSem++;
        console.log(`  - ${A.code} ${A.cls.type} ${A.cls.day} ${A.cls.startTime} (S${ta.join("+")}) × ${B.code} ${B.cls.type} ${B.cls.day} ${B.cls.startTime} (S${tb.join("+")})`);
      }
    }
  }
  if (!crossSem) console.log("  OK — classes in different semesters are never reported as clashing.");

  // 5b. Same check with the proxy's term field stripped: browsers that cached
  // timings before the term field existed must behave identically, because
  // classTerms() re-derives the semester from the week numbers.
  let staleCrossSem = 0;
  for (let i = 0; i < allClasses.length; i++) {
    for (let j = i + 1; j < allClasses.length; j++) {
      const A = allClasses[i];
      const B = allClasses[j];
      if (A.code === B.code) continue;
      const a = { ...A.cls, term: undefined };
      const b = { ...B.cls, term: undefined };
      const ta = classTerms(a);
      const tb = classTerms(b);
      if (!ta.length || !tb.length) continue;
      if (!ta.some((t) => tb.includes(t)) && classesClash(a, b)) staleCrossSem++;
    }
  }
  if (!staleCrossSem)
    console.log("  OK — same result with cached payloads that lack the term field (weeks fallback).");
  else
    console.log(`  FAIL — ${staleCrossSem} cross-semester false clashes when the term field is missing.`);

  // ---- summary
  console.log("\n================ SUMMARY ================");
  const noTt = all.filter((m) => !(live.get(m.code) && live.get(m.code).classes && live.get(m.code).classes.length));
  console.log(`Modules with a live timetable: ${withClasses.length}/${all.length}`);
  console.log(`No timetable yet: ${noTt.map((m) => m.code).join(", ") || "none"}`);
  console.log(`Impossible pairs: ${impossible.length}`);
  console.log(`Internal clashes: ${internal}`);
  console.log(`Cross-semester false clashes: ${crossSem}`);
  console.log(`Data-quality problems: ${problems.length}`);
  if (bad.length) console.log(`Fetch errors: ${bad.join(", ")}`);
  console.log(problems.length || planFails || crossSem ? "RESULT: FAILURES FOUND" : "RESULT: ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("Harness failed:", e);
  process.exit(1);
});
