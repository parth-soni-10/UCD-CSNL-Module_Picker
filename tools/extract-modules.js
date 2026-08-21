// Regenerates modules.json (the curated default module list) from the CSNL
// module-picker site. We keep only what cannot be fetched live from UCD:
//   - name    (display fallback; UCD provides the live title anyway)
//   - credits (UCD exposes no public credits API — the one curated number)
// Everything else (timings, class offerings, trimester/semester, year) is
// fetched live from UCD at runtime.
//
// Usage (from the repo root):
//   node tools/extract-modules.js                  # from the committed snapshot
//   MODULE_SOURCE_URL=https://... node tools/extract-modules.js   # live source
//
// This is the same logic the /catalogue function runs automatically every
// 1 August; the script exists for manual runs and CI.

const fs = require("fs");
const path = require("path");

const SNAPSHOT = path.join(__dirname, "..", "csnl-module-picker-snapshot.html");
const OUT = path.join(__dirname, "..", "modules.json");
const SOURCE_URL = process.env.MODULE_SOURCE_URL;

function extractFromHtml(html) {
  const marker = "const courseDataString = `";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("courseDataString not found in source");
  const from = start + marker.length;
  const end = html.indexOf("`;", from);
  if (end === -1) throw new Error("courseDataString terminator not found in source");
  const data = JSON.parse(html.slice(from, end).trim());
  if (!Array.isArray(data) || !data.every((t) => t && t.theme && Array.isArray(t.courses))) {
    throw new Error("unexpected source data shape");
  }
  return data.map((themeObj) => ({
    theme: themeObj.theme,
    courses: themeObj.courses.map((c) => ({
      name: c.name,
      credits: c.credits,
    })),
  }));
}

(async () => {
  let out;
  if (SOURCE_URL) {
    console.log(`Fetching module list from ${SOURCE_URL} …`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(SOURCE_URL, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out = extractFromHtml(await res.text());
    } finally {
      clearTimeout(timer);
    }
  } else {
    out = extractFromHtml(fs.readFileSync(SNAPSHOT, "utf8"));
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const total = out.reduce((n, t) => n + t.courses.length, 0);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${out.length} themes, ${total} modules (name + credits only)`);
})().catch((e) => {
  console.error("Extraction failed:", e.message);
  process.exit(1);
});
