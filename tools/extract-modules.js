// Extracts the CURATED module list from the original site snapshot.
// We keep only what cannot be fetched live from UCD:
//   - name    (display fallback; UCD provides the live title anyway)
//   - credits (UCD exposes no public credits API — this is the one curated number)
// Everything else (timings, class offerings, trimester/semester, year) is
// fetched live from UCD at runtime.
const fs = require("fs");

const html = fs.readFileSync("csnl-module-picker-snapshot.html", "utf8");
const start = html.indexOf("const courseDataString = `") + "const courseDataString = `".length;
const end = html.indexOf("`;", start);
const raw = html.slice(start, end);
const data = JSON.parse(raw.trim());

const out = data.map((themeObj) => ({
  theme: themeObj.theme,
  courses: themeObj.courses.map((c) => ({
    name: c.name,
    credits: c.credits,
  })),
}));

fs.writeFileSync("csnl-module-picker/modules.json", JSON.stringify(out, null, 2) + "\n");
const total = out.reduce((n, t) => n + t.courses.length, 0);
console.log(`Wrote ${out.length} themes, ${total} modules (name + credits only)`);
