#!/usr/bin/env node
"use strict";

// Per-module exam-verdict audit — the permanent record behind hasFinalExam.
//
// For EVERY module in the CSNL catalogue (all NL themes) it fetches the
// module page's Assessment Strategy table and derives a three-way verdict:
//
//   INCLUDED   hasFinalExam() = true, with the exact triggering row, the
//              reason (end-of-trimester timing and/or "final exam" wording),
//              timing and weight;
//   EXCLUDED   hasFinalExam() = false, with every exam-typed row the module
//              lists and why each one was rejected (mid-term wording,
//              in-term week numbers, presentation component, …);
//   NO DATA    the page had no Assessment Strategy table (parse failed) —
//              the module is then judged only by its timetable EXAM/EXM rows.
//
// Usage:
//   node tools/audit-exam-verdicts.js            # print the full verdict list
//   node tools/audit-exam-verdicts.js --check    # exit 1 on count drift
//
// tools/test-timetables.js runs the same audit as section [7] and fails when
// the counts drift from AUDIT_BASELINE below — bump that constant ONLY when a
// deliberate rule change moves the counts.

const { getCatalogue } = require("../netlify/functions/catalogue.js");
const { parseAssessment, hasFinalExam } = require("../netlify/functions/assessments.js");

// Recorded verdict counts. The harness fails if the live audit drifts from
// these numbers without this constant being updated (deliberate rule change).
const AUDIT_BASELINE = { included: 40, excluded: 28 };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const REASON_END = /end\s+of\s+(the\s+)?(trimester|semester)/i;
const REASON_FINAL = /\bfinal\s+exam/i;
const EXAM_TYPED = /^\s*exam/i;

// Why does this row count (or, if exam-typed, why was it rejected)?
function classify(comp) {
  if (!EXAM_TYPED.test(comp.description || "")) return null;
  const timing = comp.timing || "";
  const reasons = [];
  if (REASON_END.test(timing)) reasons.push("end-of-trimester timing");
  if (REASON_FINAL.test(comp.description || "")) reasons.push('"final exam" wording');
  if (reasons.length) return { included: true, reasons };
  let why = "no end-of-trimester timing or final-exam wording";
  if (/mid-?term/i.test(comp.description || "")) why = "mid-term (description says mid-term)";
  else if (/present|interview/i.test(comp.description || "")) why = "presentation/interview component, not an exam sitting";
  else if (/in[- ]class/i.test(comp.description || "")) why = "in-class test inside the trimester";
  else {
    const weeks = [...timing.matchAll(/week\s*(\d{1,2})/gi)].map((m) => parseInt(m[1], 10)).filter((w) => w >= 1 && w <= 15);
    if (weeks.length && Math.max(...weeks) <= 11) why = `in-term sitting (week ${Math.min(...weeks)}-${Math.max(...weeks)}, before the final week)`;
  }
  return { included: false, why };
}

async function fetchPage(code) {
  const res = await fetch(`https://www.ucd.ie/modules/${code}`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Fetches every catalogue module page once and returns:
//   { codes, included, excluded, nodata, errors, verdicts, comps }
// where verdicts is a Map(code -> boolean) for every module with assessment
// data and comps is a Map(code -> parsed rows). Quiet — prints nothing.
async function runAudit() {
  const cat = await getCatalogue();
  const seen = new Set();
  const codes = [];
  for (const t of cat.themes) {
    for (const c of t.courses) {
      const code = c.code || String(c.name).match(/\(([^)]+)\)\s*$/)?.[1];
      if (code && !seen.has(code)) { seen.add(code); codes.push(code); }
    }
  }

  const included = [];
  const excluded = [];
  const nodata = [];
  const errors = [];
  const verdicts = new Map();
  const comps = new Map();
  let i = 0;
  async function worker() {
    while (i < codes.length) {
      const code = codes[i++];
      let rows = null;
      let failed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          rows = parseAssessment(await fetchPage(code));
          break;
        } catch (e) {
          if (attempt === 1) failed = true;
          else await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!rows) {
        if (failed) errors.push(code);
        nodata.push(code);
        continue;
      }
      comps.set(code, rows);
      const verdict = hasFinalExam(rows);
      verdicts.set(code, verdict);
      (verdict ? included : excluded).push(code);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  return { codes, included, excluded, nodata, errors, verdicts, comps };
}

// Human-readable verdict detail for one module from its parsed rows.
function explain(code, rows) {
  const typed = rows.map((c) => ({ comp: c, res: classify(c) })).filter((x) => x.res);
  const verdict = hasFinalExam(rows);
  if (verdict) {
    const trig = typed.find((x) => x.res.included);
    return {
      verdict,
      lines: [
        `Exam-typed row that counts: "${(trig.comp.description || "").slice(0, 60)}" | ${trig.comp.timing} | ${trig.comp.weight == null ? "?" : trig.comp.weight + "%"} — ${trig.res.reasons.join(" + ")}`,
      ],
    };
  }
  const lines = typed.length
    ? typed.map((x) => `· "${(x.comp.description || "").slice(0, 70)}" | ${x.comp.timing} | ${x.comp.weight == null ? "?" : x.comp.weight + "%"} — excluded: ${x.res.why}`)
    : ["no exam-typed rows"];
  return { verdict, lines };
}

async function main() {
  const check = process.argv.includes("--check");
  const cat = await getCatalogue();
  console.log(`Auditing ${cat.themes.reduce((n, t) => n + t.courses.length, 0)} catalogue entries across ${cat.themes.length} NL themes (target year ${cat.year || "?"})\n`);

  const audit = await runAudit();
  for (const code of audit.codes) {
    if (audit.errors.includes(code)) { console.log(`  [ERROR]     ${code} — could not fetch the module page`); continue; }
    if (audit.nodata.includes(code)) { console.log(`  [NO DATA]   ${code} — no Assessment Strategy table on the page`); continue; }
    const { verdict, lines } = explain(code, audit.comps.get(code));
    if (verdict) console.log(`  [INCLUDED]  ${code} — ${lines[0]}`);
    else { console.log(`  [EXCLUDED]  ${code}`); for (const l of lines) console.log(`    ${l}`); }
  }

  console.log("\n================ EXAM-VERDICT AUDIT ================");
  console.log(`INCLUDED (final exam): ${audit.included.length} — ${audit.included.sort().join(", ")}`);
  console.log(`EXCLUDED (exam-free):  ${audit.excluded.length} — ${audit.excluded.sort().join(", ")}`);
  console.log(`NO DATA (no table):    ${audit.nodata.length}${audit.nodata.length ? " — " + audit.nodata.sort().join(", ") : ""}`);
  if (audit.errors.length) console.log(`FETCH ERRORS:          ${audit.errors.sort().join(", ")}`);

  if (check) {
    const drifted = audit.included.length !== AUDIT_BASELINE.included || audit.excluded.length !== AUDIT_BASELINE.excluded;
    if (drifted) {
      console.log(
        `\nCHECK FAILED — counts differ from the recorded baseline (included ${audit.included.length} vs ${AUDIT_BASELINE.included}, excluded ${audit.excluded.length} vs ${AUDIT_BASELINE.excluded}).\nIf the change is deliberate, update AUDIT_BASELINE in tools/audit-exam-verdicts.js; if not, hasFinalExam has a bug.`
      );
      process.exitCode = 1;
    } else {
      console.log(`\nCHECK OK — counts match the recorded baseline (included ${AUDIT_BASELINE.included}, excluded ${AUDIT_BASELINE.excluded}).`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Audit failed:", e);
    process.exit(1);
  });
}

module.exports = { runAudit, explain, classify, AUDIT_BASELINE };
