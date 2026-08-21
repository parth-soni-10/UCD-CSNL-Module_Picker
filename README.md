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
| Module list (streams, core/optional, semester, credits, comments) | **Live from UCD's official CSNL page** (ucd.ie/cs/study/postgraduate/nlstreams) — re-checked on every load and on 1 August |
| New modules each year | **Appear automatically** — whatever UCD publishes on the CSNL streams page is what the site offers |

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

- The module list comes from **UCD's own CSNL page** —
  https://www.ucd.ie/cs/study/postgraduate/nlstreams/ — which lists every
  module CSNL students can take, organized into the **official streams** with
  core/optional flags, semester, credits and comments. There is **no curated
  data**: whatever UCD publishes there each year is exactly what the site
  offers, so new modules appear and retired ones disappear automatically.
- On every request, `/catalogue` re-checks the page; if UCD has changed it
  (the page's `page_last_update` stamp differs), the list is regenerated
  immediately — the site can't go stale even mid-year.
- A **scheduled function** (`refresh-catalogue`) also runs at `00:00 UTC` on
  **1 August** to pre-warm the fresh list for the new academic year.
- If the CSNL page is unreachable, the service falls back to UCD's generic
  current-year module catalogue (credits refreshed), and finally to the
  committed `modules.json` — per-module timings are still fetched live from
  UCD, so nothing breaks.

Timings, titles, trimesters and the auto-picked latest academic year are
fetched live per module on every page load, so the yearly refresh only needs
UCD to have published the new list once.

Timings, titles, trimesters and the auto-picked latest academic year are
fetched live per module on every page load, so the yearly refresh only needs
UCD to have published the new list once.

Manually regenerate the committed fallback list anytime:

```bash
node tools/extract-modules.js   # fetches the CSNL streams page from UCD
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
| `modules.json` | Fallback module list (streams, credits, semester, comments — **no timings**), regenerated from the CSNL page; last-resort fallback for `/catalogue` |
| `netlify/functions/timetable.js` | Live-timings proxy + UCD HTML parser |
| `netlify/functions/catalogue.js` | Auto-refreshing module list service (Netlify Blobs + fallback) |
| `netlify/functions/refresh-catalogue.js` | Scheduled 1-August refresh (cron in `netlify.toml`) |
| `server.js` | Zero-dependency local server (mounts both functions) |
| `netlify.toml` | Netlify config (publish `.`, functions dir, cron schedule) |

## Notes

- Not an official UCD service. Data sources:
  https://www.ucd.ie/students/course_search/generalreferencetimetable/ (timings)
  and https://www.ucd.ie/cs/study/postgraduate/nlstreams/ (the CSNL module list).
- Selections, added module codes and timetables are stored in your browser's
  `localStorage`. Selections are matched to classes by their live schedule key,
  so they keep working even after times change.
- The only runtime dependency is `@netlify/blobs` (used by `/catalogue` on
  Netlify); Netlify installs it automatically. Locally, `node server.js` works
  with zero installed dependencies — the catalogue caches in memory instead.
