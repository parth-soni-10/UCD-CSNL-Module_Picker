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
| Module code list (default view) | Curated themes, **auto-refreshed from UCD's own module catalogue every 1 August** |
| Credits | **Live from UCD's module catalogue**, refreshed yearly |
| New modules each year | **Auto-discovered from UCD** into a lazy "More UCD Modules" theme |

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

## Automatic yearly refresh (1 August) — UCD is the source of truth

UCD publishes the next academic year's module set around the start of August.
The whole site updates itself every **1 August**, with no code change:

- A **scheduled function** (`refresh-catalogue`) runs at `00:00 UTC` on
  **1 August** and pulls **UCD's own published module catalogue** (the
  "Search All Modules" listing, `p_tag=MODULESCURRENT` — every module UCD
  offers, with credits, level and school).
- The `/catalogue` service rebuilds the module list from it:
  - curated themes keep their grouping, but **credits are refreshed from UCD**
    (they're no longer curated data);
  - every School of Computer Science module at levels 3–4 that isn't already
    curated is **auto-added** under a "More UCD Modules" theme, so genuinely
    new modules appear automatically each year — and modules UCD retires
    disappear from that theme on their own;
  - the auto theme is **lazy**: its timings are fetched from UCD only when you
    expand it, keeping the initial load fast and UCD requests polite.
- The refreshed list is stored in **Netlify Blobs**. If the scheduled run is
  ever missed, the first page load on/after 1 August regenerates it
  automatically — and because the stored year is the academic year UCD itself
  reports in the data, the service keeps re-checking until UCD actually
  publishes the new year's list.
- If UCD's catalogue is unreachable, the site falls back to the committed
  `modules.json` — per-module timings are still fetched live from UCD, so
  nothing breaks.

Timings, titles, trimesters and the auto-picked latest academic year are
fetched live per module on every page load, so the yearly refresh only needs
UCD to have published the new list once.

Manually regenerate the committed seed list anytime:

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
| `modules.json` | Curated seed module list (name + credits — **no timings**); fallback for `/catalogue` |
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
