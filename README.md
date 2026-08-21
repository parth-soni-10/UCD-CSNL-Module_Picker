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
| Module code list (default view) | Curated, **auto-refreshed every 1 August** via `/catalogue` + **add any code live at runtime** |
| Credits | Curated (UCD exposes no public credits API), refreshed with the list on 1 August |

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

## Automatic yearly refresh (1 August)

UCD publishes the next academic year's module set around the start of August.
The module list updates itself every **1 August**, no code change needed:

- A **scheduled function** (`refresh-catalogue`) runs at `00:00 UTC` on
  **1 August** and re-scrapes the module list from the CSNL module-picker site
  (override the source with the `MODULE_SOURCE_URL` env var).
- The catalogue is served to the frontend by `/catalogue`, which stores the
  refreshed list in **Netlify Blobs**. If the scheduled run is ever missed, the
  first page load on/after 1 August regenerates it automatically (the year
  stamp on the stored list is compared against the current date).
- If the source site is down or unparseable, the site falls back to the
  committed `modules.json` — timings for every existing module are still
  fetched live from UCD, so nothing breaks.
- Timings, titles, trimesters and the auto-picked latest academic year were
  already live per module, so the refresh only concerns which modules appear
  and their credits.

Manually regenerate the committed list anytime:

```bash
node tools/extract-modules.js                              # from the snapshot
MODULE_SOURCE_URL=https://csnl-module-picker.onrender.com/ node tools/extract-modules.js
```

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

1. **Drag & drop**: upload this folder at https://app.netlify.com/drop
   (functions included).
2. **Git**: push to a repo and connect it to Netlify — no build command,
   publish directory `.`, Node 18+.

## Files

| File | Purpose |
| --- | --- |
| `index.html` / `styles.css` / `app.js` | The site |
| `modules.json` | Curated default module list (name + credits only — **no timings**); fallback for `/catalogue` |
| `netlify/functions/timetable.js` | Live-timings proxy + UCD HTML parser |
| `netlify/functions/catalogue.js` | Auto-refreshing module list service (Netlify Blobs + fallback) |
| `netlify/functions/refresh-catalogue.js` | Scheduled 1-August refresh (cron in `netlify.toml`) |
| `server.js` | Zero-dependency local server (mounts both functions) |
| `netlify.toml` | Netlify config (publish `.`, functions dir, cron schedule) |

## Notes

- Not an official UCD service. Data sources:
  https://www.ucd.ie/students/course_search/generalreferencetimetable/ (timings)
  and the CSNL module-picker site (curated module list).
- Selections, added module codes and timetables are stored in your browser's
  `localStorage`. Selections are matched to classes by their live schedule key,
  so they keep working even after times change.
- The only runtime dependency is `@netlify/blobs` (used by `/catalogue` on
  Netlify); Netlify installs it automatically. Locally, `node server.js` works
  with zero installed dependencies — the catalogue caches in memory instead.
