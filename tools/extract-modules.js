// Regenerates modules.json (the committed fallback module list) from UCD's
// official CSNL page — "MSc Computer Science by Negotiated Learning" — which
// lists every module CSNL students can take, organized into the official
// streams with core/optional flags, semester, credits and comments:
//
//     https://www.ucd.ie/cs/study/postgraduate/nlstreams/
//
// This is the same logic the /catalogue function runs automatically on every
// request (and the scheduled refresh runs daily); the script exists for
// manual runs and CI so the committed fallback mirrors the live source.
//
// Usage (from the repo root):
//   node tools/extract-modules.js
//   NL_STREAMS_URL=https://... node tools/extract-modules.js   # custom source

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "modules.json");
const SOURCE_URL =
  process.env.NL_STREAMS_URL || "https://www.ucd.ie/cs/study/postgraduate/nlstreams/";

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

function parseNlStreams(html) {
  const items = html.split(/<article class="accordion-item"/).slice(1);
  if (!items.length) throw new Error("no stream panels found on the CSNL page");
  const streams = [];
  for (const item of items) {
    const nameM = item.match(/accordion-button[^>]*>([^<]+)</);
    if (!nameM) continue;
    const stream = { name: nameM[1].trim(), modules: [] };
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
  for (const s of streams) {
    const seen = new Set();
    s.modules = s.modules.filter((m) => {
      const k = m.code + "|" + m.semester;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return streams;
}

(async () => {
  console.log(`Fetching CSNL streams from ${SOURCE_URL} …`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let html;
  try {
    const res = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const streams = parseNlStreams(html);
  const out = streams.map((s) => ({
    theme: s.name,
    courses: s.modules.map((m) => ({
      name: `${m.title} (${m.code})`,
      credits: m.credits,
      kind: m.kind,
      semester: m.semester,
      ...(m.comments ? { comments: m.comments } : {}),
    })),
  }));

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const total = out.reduce((n, t) => n + t.courses.length, 0);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${out.length} streams, ${total} module entries`);
})().catch((e) => {
  console.error("Extraction failed:", e.message);
  process.exit(1);
});
