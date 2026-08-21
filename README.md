# CSNL Module Picker

A simple, good-looking module picker for UCD Computer Science students that
builds a clash-free weekly timetable. **Everything that can change year-to-year
is fetched live from UCD on every page load** — the site is self-sustaining
across future academic years:

| What | Source |
| --- | --- |
| Class timings (day, start, end, weeks, room) | **Live** — UCD General Reference Timetable (hub.ucd.ie, reports CM802/CM801) |
| Class offerings (Lecture/Practical/Tutorial, offering numbers) | **Live** — same |
| Module title | **Live** — UCD |
| Academic year (auto-picks the latest published) | **Live** — UCD |
| Trimester / semester (Autumn, Spring, or both) | **Live** — UCD |
| Module code list (default view) | Curated `modules.json` (the themes) + **add any code live at runtime** |
| Credits | Curated `modules.json` (UCD exposes no public credits API) |

There are **no hardcoded timings anywhere**. When UCD updates a schedule —
or publishes next year's timetable — the picker shows it automatically.
Modules with no timetable yet show UCD's own reason ("currently not timetabled",
"no schedule details available") instead of stale data.

## How it works

1. On page load the frontend asks the serverless proxy for every module's
   timetable.
2. The proxy (`netlify/functions/timetable.js`) searches UCD for each module,
   grabs the "View Timetable" link for the **latest academic year**, downloads
   the published weekly schedule and normalizes it to JSON.
3. Results are cached in-memory for 30 minutes so repeat loads are fast and we
   don't hammer UCD. **↻ Refresh timings** forces a fresh pull from UCD.
4. Use the **"Add any UCD module code"** box to pull in modules that aren't in
   the default list — the code is remembered, but its timings are always
   re-fetched live.

## Run locally

```bash
node server.js
# → http://localhost:8787
```

`server.js` serves the static site and mounts the timetable proxy at the same
URL Netlify uses (`/.netlify/functions/timetable`), so local behaviour matches
production exactly. Node 18+ is required; there are no dependencies.

## Deploy to Netlify

No build step. Either:

1. **Drag & drop**: upload the `csnl-module-picker` folder at
   https://app.netlify.com/drop (functions included).
2. **Git**: push to a repo and connect it to Netlify — no build command,
   publish directory `.`, Node 18+.

## Files

| File | Purpose |
| --- | --- |
| `index.html` / `styles.css` / `app.js` | The site |
| `modules.json` | Curated default module list (name + credits only — **no timings**) |
| `netlify/functions/timetable.js` | Live-timings proxy + UCD HTML parser |
| `server.js` | Zero-dependency local server |
| `netlify.toml` | Netlify config (publish `.`, functions dir) |

## Notes

- Not an official UCD service. Data source:
  https://www.ucd.ie/students/course_search/generalreferencetimetable/
- Selections, added module codes and timetables are stored in your browser's
  `localStorage`. Selections are matched to classes by their live schedule key,
  so they keep working even after times change.
- To regenerate `modules.json` from the original site's snapshot:
  `node tools/extract-modules.js` (run from the repo root).
