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
| Module list (streams, core/optional, semester, credits, comments) | **Live from UCD's official CSNL page** (ucd.ie/cs/study/postgraduate/nlstreams) — re-checked on every load and daily |
| New modules each year | **Appear automatically** — whatever UCD publishes on the CSNL streams page is what the site offers |

There are **no hardcoded timings anywhere**. When UCD updates a schedule —
or publishes next year's timetable — the picker shows it automatically.
Modules with no timetable yet show UCD's own reason ("currently not timetabled",
"no schedule details available") instead of stale data: **only the target
academic year's timetable is ever served** (the year the site is planning for,
which advances on 1 August). If UCD has published the year entry but not the
schedule, the module shows "no timetable" rather than last year's times.

## How it works

1. On page load the frontend asks the serverless proxy for every module's
   timetable.
2. The proxy (`netlify/functions/timetable.js`) searches UCD for each module,
   grabs the "View Timetable" link for the **latest academic year**, downloads
   the published weekly schedule and normalizes it to JSON.
3. Results are cached in-memory for 30 minutes so repeat loads are fast and we
   don't hammer UCD. **↻ Refresh timings** forces a fresh pull from UCD, and
   the page also **auto-refreshes every 30 minutes** (skipping while the tab
   is hidden, and catching up when it's shown again) so timings stay current
   without touching anything.
4. Use the **"Add any UCD module code"** box to pull in modules that aren't in
   the default list — the code is remembered, but its timings are always
   re-fetched live.

## Periodic refresh — UCD is the source of truth

UCD publishes the next academic year's module set around the start of August,
and can adjust the offering list at any time. The module list is kept current
on three levels, with no code change:

- The module list comes from **UCD's own CSNL page** —
  https://www.ucd.ie/cs/study/postgraduate/nlstreams/ — which lists every
  module CSNL students can take, organized into the **official streams** with
  core/optional flags, semester, credits and comments. There is **no curated
  data**: whatever UCD publishes there each year is exactly what the site
  offers, so new modules appear and retired ones disappear automatically.
- On every request, `/catalogue` re-reads the page; if UCD has changed it
  (the page's `page_last_update` stamp differs), the list is regenerated
  immediately — the site can't go stale even mid-year.
- A **scheduled function** (`refresh-catalogue`) re-reads the page **daily**
  at `00:00 UTC` (`0 0 * * *`), so the stored list stays current even with
  zero visitors. It compares the page stamp and only rewrites the blob when
  UCD actually changed the list.
- If the CSNL page is unreachable, the service falls back to UCD's generic
  current-year module catalogue (credits refreshed), and finally to the
  committed `modules.json` — per-module timings are still fetched live from
  UCD, so nothing breaks.

  The timetable proxy's allowlist — which codes it will fetch — is rebuilt
  from this same live catalogue (cached in memory for a few minutes), so a
  module UCD adds to the NL page is offered by the site *and* fetchable
  immediately; the committed `modules.json` only serves as the offline
  fallback if the catalogue can't be reached.

Timings, titles, trimesters and the auto-picked latest academic year are
fetched live per module on every page load, so the yearly refresh only needs
UCD to have published the new list once.

## Browser cache (fast repeat visits)

The last-fetched timings are saved to the browser's `localStorage`
(`csnlPicker:timings:v1`). On a repeat visit the picker restores them
instantly — the boot screen shows "Restored N saved timetables — refreshing
from UCD…" and the page is usable right away — then re-fetches live timings
from UCD in the background and overwrites the cache. This never replaces the
live fetch (the cache is only for the first paint); selections and timings
always refresh from UCD on every load.

Manually regenerate the committed fallback list anytime:

```bash
node tools/extract-modules.js   # fetches the CSNL streams page from UCD
```

## Run locally

```bash
node server.js
# → http://localhost:8787
```

## Test against the live UCD data

```bash
node tools/test-timetables.js [--fresh]   # server must be running
```

Fetches the catalogue and every module's timetable through the local proxy,
then runs the same logic the frontend uses against **every combination**:

- data quality (target year only, clean term codes/CRNs, sane times/weeks);
- **every module pair** — which pairs can never be taken together (no
  clash-free assignment exists) and which modules' own classes overlap;
- **cross-semester separation** — classes in different semesters (Autumn
  weeks 1-12 vs Spring weeks 20-33) are never reported as clashing;
- the **clash-free plan builder** for 30/60/90-credit targets in every
  semester — every suggested plan is re-verified as genuinely clash-free and
  within the CSNL credit rules.

Use `--fresh` to bypass the proxy's 30-minute cache and pull straight from
UCD. Any problem is listed in the output and the run ends with a
`RESULT: ALL CHECKS PASSED` / `RESULT: FAILURES FOUND` line.

The weekly timetable has an **All / Autumn / Spring selector** above the grid:
clash detection runs over the visible semester only, so a Spring module and an
Autumn module that happen to share a day/time slot are never mistaken for a
clash. The choice is remembered and reflected in the URL (`?tm=`) and the
print header.

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
| `tools/test-timetables.js` | Test harness — fetches every live timetable and checks data quality, every module pair for clashes, and the clash-free plan builder |
| `netlify/functions/timetable.js` | Live-timings proxy + UCD HTML parser |
| `netlify/functions/catalogue.js` | Auto-refreshing module list service (Netlify Blobs + fallback) |
| `netlify/functions/refresh-catalogue.js` | Scheduled daily catalogue check (cron in `netlify.toml`) |
| `server.js` | Zero-dependency local server (mounts both functions) |
| `netlify.toml` | Netlify config (publish `.`, functions dir, cron schedule) |

## Notes

- Not an official UCD service. Data sources:
  https://www.ucd.ie/students/course_search/generalreferencetimetable/ (timings)
  and https://www.ucd.ie/cs/study/postgraduate/nlstreams/ (the CSNL module list).
- Selections, added module codes, the theme choice and the cached timings are
  stored in your browser's `localStorage`. Selections are matched to classes
  by their live schedule key, so they keep working even after times change.
- The only runtime dependency is `@netlify/blobs` (used by `/catalogue` on
  Netlify); Netlify installs it automatically. Locally, `node server.js` works
  with zero installed dependencies — the catalogue caches in memory instead.
