# CSNL Module Picker

## Architecture and deployment
- Keep the app vanilla HTML, CSS, and JavaScript. The Cloudflare Pages asset build is `node tools/deploy-pages.mjs --assets . --out .pages-dist`; Pages Functions remain under `functions/` and must not be copied into the asset directory.
- `app.js` and `styles.css` are versioned together by the SHA-256 prefix in the `app.js?v=` script URL. The service worker uses that version for its cache and waits for an explicit update action before activation.
- Keep the strict self-only `script-src` and `style-src` policy in `_headers`. Avoid inline executable scripts, event handlers, style attributes, and runtime style injection.

## Data and interaction rules
- `modules.json` is the catalogue. Timetable and assessment data come from the existing Pages Functions and live UCD sources; do not invent schedules or assessment facts.
- Preserve share URLs `?q=<search>&t=<saved-timetable>&tm=<1|2|all>&s=<CODE:offering-list,…>` and their initial-render/history behavior. `1` and `2` encode the first and second semester views. Test encoded module/offering state after URL changes.
- Keep the suggest form endpoint `/.netlify/functions/suggestions`, its `name`, `email`, `suggestion`, and `bot-field` fields, and the honeypot. Its Pages Function stores submissions through the existing `STORE_KV` binding.
- Keep keyboard access, visible focus, reduced-motion behavior, responsive touch targets, and light/dark WCAG AA contrast when changing component behavior or tokens.
- Motion timings come from the shared `--motion-duration-*` and `--motion-ease-*` tokens declared in `:root`; do not hard-code a duration in a transition — map it to a tier.
- Several components only exist once a plan does. Verify with `PICKER_BASE_URL=http://127.0.0.1:<port>/ node tools/verify-picker.mjs`, which seeds a real selection through the `?s=` share parameter; an empty picker renders one swipe row and looks like a pass while checking almost nothing. It also drives the keyboard-only journey (disclosure, semester arrows, workspace tabs, dialog open/close, first twenty tab stops) and the update prompt: a worker registered under a changed version query must reach `waiting`, the banner must announce itself with `role="status"`, and `SKIP_WAITING` must activate that worker.
- Keep the disclaimer that this is an unofficial UCD planner and that users must verify module details with UCD.
