/* ---------------------------------------------------------------------------
 * UCD CSNL Module Picker — the agent-facing documents.
 *
 * `_router.js` serves these. Nothing here scrapes UCD, touches the catalogue or
 * changes the app: the browser app stays the source of truth for live timings,
 * and this module is the stable description an agent can read without running
 * it. The documents name the JSON endpoints the same deployment already
 * answers, so an agent has one place to look before calling anything.
 *
 * The one thing that goes stale here is the module list itself, which changes
 * every academic year. The documents therefore point at the live catalogue
 * endpoint instead of repeating module names or counts.
 * ------------------------------------------------------------------------ */

export const SITE = "https://ucdcsnlmodulepicker.pages.dev";
export const EMAIL = "soni.soni.parth@gmail.com";
export const REPO = "https://github.com/parth-soni-10/UCD-CSNL-Module_Picker";
export const DISCORD = "https://discord.gg/6Jp2hVFYdt";
export const PORTFOLIO = "https://parth-portfolio-wb.pages.dev/";
export const UCD_STREAMS = "https://www.ucd.ie/cs/study/postgraduate/nlstreams/";
export const UCD_TIMETABLE =
  "https://www.ucd.ie/students/course_search/generalreferencetimetable/";

const lines = (...parts) => parts.join("\n").trim() + "\n";

export const HOME_MARKDOWN = lines(
  "# CSNL Module Picker",
  "",
  "**CSNL Module Picker** is a free, browser-based timetable builder for UCD's Computer Science",
  "(Negotiated Learning, CSNL) master's programme. It lists the modules UCD offers to CSNL",
  "students, fetches each module's live class times from UCD's General Reference Timetable, and",
  "builds a weekly grid that flags clashes across Autumn and Spring.",
  "",
  `- **Live site:** ${SITE}/`,
  `- **Author:** Parth Soni (${PORTFOLIO})`,
  `- **Contact:** ${EMAIL}`,
  `- **Source:** ${REPO}`,
  `- **Community:** ${DISCORD}`,
  "- **Cost:** free, no account, no sign-in.",
  "",
  "## When to use this",
  "",
  "Reach for this site when the job is one of these:",
  "",
  "- **Choosing CSNL modules for a year.** Browse every module on UCD's CSNL streams list with",
  "  credits, core/optional status, semester and the lecturer's own comments, then tick the ones",
  "  under consideration.",
  "- **Checking whether two modules clash.** Select modules and read the weekly grid: overlapping",
  "  classes are highlighted, and same-time classes in different trimesters are not counted as a",
  "  clash because they never run together.",
  "- **Building a plan to a credit target.** The plan builder searches for clash-free combinations",
  "  at 30, 60 or 90 credits, optionally excluding 9am starts, Fridays or days over a cap, and has",
  "  a separate no-final-exam mode.",
  "- **Finding exam-free modules.** Filters and a planner mode use the assessment information on",
  "  each module's UCD page to keep modules without a final exam.",
  "- **Reading a module's live timetable.** Day, time, weeks, trimester and room come from UCD, so",
  "  a room change or a new semester is reflected without this site being updated.",
  "- **Comparing candidate selections.** Several named timetables can be kept side by side, and a",
  "  selection can be exported to JSON and imported again.",
  "",
  "Do **not** use it for official registration, a degree audit, exam timetables, fee or visa",
  "advice, or modules outside the CSNL list. UCD's own systems are the authority for what a student",
  "may actually register for; this tool only plans.",
  "",
  "## How to call it",
  "",
  "The product is an interactive page, but the data behind it is served as JSON by the same",
  "deployment, unauthenticated and without cookies. Read the site as an agent:",
  "",
  "- `GET /` with `Accept: text/markdown` returns this document; `Accept: text/html` returns the app.",
  "- `/index.md`, `/about.md`, `/contact.md` and `/privacy.md` always return Markdown.",
  "- `/llms.txt` is the compact guide and `/sitemap.xml` lists every published page.",
  "- An unknown path requested as Markdown returns HTTP 404 with a Markdown body; as HTML it",
  "  returns the site's 404 page, also with HTTP 404.",
  "",
  "### JSON endpoints",
  "",
  "- `GET /.netlify/functions/catalogue` — the current CSNL list. Shape:",
  "  `{ source, pageUpdated, generatedAt, verified, themes: [{ theme, courses: [{ name, credits,",
  "  kind, semester, comments }] }] }`. `name` includes the module code in parentheses.",
  "  `GET .../catalogue?action=health` returns freshness and counts only, never the full payload.",
  "- `GET /.netlify/functions/timetable?codes=COMP30960,COMP30030` — live timings for up to 80",
  "  comma-separated codes. Shape: `{ generatedAt, source, cacheTTLMinutes, results: { CODE: {",
  "  found, title, year, semester, trimesters, classes: [{ day, startTime, endTime, room, weeks,",
  "  term }] } }, errors }`. A code UCD has not timetabled answers `found: true` with a `reason`",
  "  and no classes. Codes that are not on the current CSNL list answer `found: false` with a",
  "  reason; a request with no codes answers HTTP 400.",
  "- `GET /.netlify/functions/assessments` — the assessment map read from UCD module pages,",
  "  cached for 5 minutes, with an optional `?force=1` refresh.",
  "- `POST /.netlify/functions/suggestions` — the suggestion form's endpoint, form-encoded fields",
  "  `name`, `email`, `suggestion`. It stores a suggestion for the maintainer; it is not a",
  "  general-purpose API.",
  "",
  "`semester` is `\"1\"` for Autumn, `\"2\"` for Spring and `\"1, 2\"` for both. `term` on a class is",
  "the trimester(s) its weeks fall in, which is what makes cross-semester non-clashes possible.",
  "",
  "```bash",
  `curl -sS -H 'Accept: text/markdown' ${SITE}/`,
  `curl -sS ${SITE}/llms.txt`,
  `curl -sS '${SITE}/.netlify/functions/timetable?codes=COMP30960'`,
  "```",
  "",
  "## How it works",
  "",
  "1. **Catalogue.** UCD's CSNL streams page supplies the module list, streams, credits,",
  "   core/optional flags, semester and comments. The generic UCD module catalogue fills in",
  "   descriptions. The result is held in a KV namespace and re-checked on request, with a",
  "   committed list as the last-resort fallback.",
  "2. **Timings.** Each module code is resolved against UCD's General Reference Timetable for the",
  "   current academic year. Only the target year counts: if UCD has not published it, the module",
  "   says so rather than showing an older timetable.",
  "3. **Clashes.** Classes are compared by day, time and term. Two classes clash only when they",
  "   overlap in time and share at least one trimester, which keeps Autumn and Spring modules from",
  "   being reported as conflicting.",
  "4. **State.** Selections, added codes, the active timetable, the theme and cached timings live in",
  "   the visitor's `localStorage`; nothing about a selection is sent to a server.",
  "",
  "## Data and limits",
  "",
  "- **Not an official UCD service.** It reads public UCD pages; it cannot register a student or",
  "  change a record.",
  "- **UCD is the source of truth.** If UCD changes a room, a week pattern or a module's",
  "  availability, the site follows on the next load. When UCD is unreachable the site says so",
  "  instead of inventing timings.",
  "- **CSNL only.** Modules outside UCD's CSNL list are rejected by the timetable endpoint rather",
  "  than proxied.",
  "- **Exam data is inferred.** \"Exam-free\" means no final exam was found on the module page; it is",
  "  a filter, not a guarantee about continuous assessment.",
  "- **One year at a time.** The timetable is always the current academic year (UCD advances it",
  "  around 1 August), not an arbitrary past or future year.",
  ""
);

export const ABOUT_MARKDOWN = lines(
  "# About CSNL Module Picker",
  "",
  "CSNL Module Picker is an independent, free web tool that helps a UCD Computer Science",
  "(Negotiated Learning) master's student choose modules and see the weekly timetable those",
  "choices produce. UCD publishes module lists, credits and class times, but not one view that",
  "combines them into a clash-free week. This site builds that view from UCD's own pages.",
  "",
  "## Who runs it",
  "",
  "It is built and maintained by **Parth Soni**, a UCD computer science student, as a personal",
  "project. It is not affiliated with, endorsed by or operated by University College Dublin. The",
  "source is public at " + REPO + ".",
  "",
  "## What it does",
  "",
  "- Lists every module on UCD's CSNL streams list, grouped by stream and theme, with credits,",
  "  core/optional status, semester and the module's own comments.",
  "- Fetches each selected module's live timetable from UCD's General Reference Timetable, so day,",
  "  time, weeks, trimester and room are current rather than copied into this site.",
  "- Draws an Autumn, Spring or combined weekly grid and marks overlapping classes.",
  "- Searches for clash-free module combinations at a target credit total, with optional no-9am,",
  "  no-Friday and maximum-classes-per-day preferences.",
  "- Offers a no-final-exam plan for students who want to avoid exam-heavy semesters.",
  "- Keeps several named timetables, and exports or imports them as JSON.",
  "",
  "## Where the data comes from",
  "",
  "- **Module list and stream structure:** UCD's CSNL streams page, " + UCD_STREAMS + ".",
  "- **Module descriptions and assessment components:** UCD's module catalogue pages.",
  "- **Class times:** UCD's General Reference Timetable, " + UCD_TIMETABLE + ".",
  "",
  "The catalogue is re-checked on request and by a scheduled refresh twice a month. Modules UCD",
  "adds appear without a code change; modules UCD withdraws stop being offered. Timings are fetched",
  "for the current academic year only, and a module whose timetable UCD has not yet published says",
  "so instead of showing last year's times.",
  "",
  "## What it is not",
  "",
  "This is a planning aid. It does not register you, reserve a place, confirm that you meet a",
  "module's prerequisites, or replace your programme office. Registration rules, capacity limits",
  "and assessment regulations are UCD's, and UCD's systems and staff are the authority on them.",
  "Always confirm a final selection against UCD before you register.",
  "",
  "## Cost and accounts",
  "",
  "There is no account, no paywall and no advertising. Selections stay in the browser. The",
  "suggestion form is the only thing that sends anything to this site, and it exists so users can",
  "report missing modules or wrong timings. See [Privacy](/privacy) for the detail.",
  "",
  "## Corrections and questions",
  "",
  `Missing a module, or seen a time that looks wrong? Email **${EMAIL}**, use the suggestion form`,
  `on the [module picker](${SITE}/), or open an issue at ${REPO}. Privacy questions go to the same`,
  "address, and the [Privacy](/privacy) page lists everything the site stores.",
  ""
);

export const CONTACT_MARKDOWN = lines(
  "# Contact CSNL Module Picker",
  "",
  "This is a one-person project. Reports of a wrong timing, a missing module or a broken page are",
  "genuinely useful, and they are read by the maintainer.",
  "",
  "## Email",
  "",
  `**${EMAIL}**`,
  "",
  "Use email for anything that should not be public: a data error, a module that UCD offers but the",
  "site omits, a privacy question, or a request to remove something. There is no support contract",
  "and no guaranteed response time; most messages get a reply when they can be acted on.",
  "",
  "## The suggestion form",
  "",
  "The homepage has a **Suggestions** panel. A suggestion sent there is stored with this site so it",
  "can be worked through, and an optional email address is kept only so a reply is possible. It is",
  "the right place for \"please add this module\" or \"this time looks wrong\".",
  "",
  "## Discord",
  "",
  `UCD CS NL students run a Discord with a channel per CSNL module: ${DISCORD}. Questions about a`,
  "module's workload or exam style usually get a faster answer from other students there than from",
  "this site's maintainer.",
  "",
  "## Source code and issue tracker",
  "",
  `The site is open source at ${REPO}. Bugs, timetable-parsing failures and feature requests can`,
  "be filed there as issues, which keeps the history with the code.",
  "",
  "## What this site cannot do",
  "",
  "It cannot change your registration, add you to a module, answer a fees or visa question, or",
  "override UCD policy. Those belong to your programme office and UCD Student Desk, not to a",
  "timetable planner.",
  ""
);

export const PRIVACY_MARKDOWN = lines(
  "# Privacy",
  "",
  "Last updated: 21 October 2026.",
  "",
  "CSNL Module Picker is a static site with a small server-side proxy. It has no accounts, no",
  "advertising and no analytics or tracking scripts. This page explains the little data it does",
  "handle.",
  "",
  "## What stays in your browser",
  "",
  "Your selected modules, added module codes, named timetables, chosen theme and the last fetched",
  "timings are stored in your browser's `localStorage`, on your device. They are never sent to this",
  "site or to UCD. Clearing site data or using a private window removes them, and a JSON export is",
  "a file you download.",
  "",
  "## What this site stores on its server",
  "",
  "The only user-submitted data is the suggestion form. When you send a suggestion, the message, an",
  "optional name and an optional email address are stored in this site's Cloudflare KV namespace so",
  "the maintainer can act on them. The store keeps at most the most recent 500 suggestions, and",
  "entries are removed as they are handled. Nothing else you do is written to a server.",
  "",
  "## Requests to UCD",
  "",
  "Timings and module pages are fetched by this site's own server-side proxy, so your browser does",
  "not talk to UCD directly for that data, and UCD does not receive your IP address from those",
  "requests. Your browser does load fonts, scripts and styles only from this domain. Following a",
  "link to UCD, Discord, GitHub or the maintainer's portfolio takes you to that service under its",
  "own privacy policy.",
  "",
  "## Hosting and logs",
  "",
  "The site is hosted on Cloudflare Pages, which processes requests and keeps standard",
  "operational logs (IP address, user agent, requested URL, timestamp) as any web host does, for",
  "security and reliability. This project does not build profiles from those logs, combine them",
  "with anything else, or sell or share data.",
  "",
  "## Cookies",
  "",
  "This site sets no cookies. There is no consent banner because there is nothing to consent to.",
  "",
  "## Your rights",
  "",
  "If you have sent a suggestion and want it removed, or want to know what is held about it, email",
  `**${EMAIL}**. Under the GDPR you may also ask for access, correction or erasure, and you have the`,
  "right to complain to the Irish Data Protection Commission (https://www.dataprotection.ie/). If",
  "this notice changes, the date at the top changes with it.",
  ""
);

export function notFoundMarkdown(pathname) {
  const path = pathname && pathname !== "/" ? String(pathname).replace(/`/g, "'") : "this address";
  return lines(
    "# Page not found",
    "",
    `Nothing is published at \`${path}\` on ucdcsnlmodulepicker.pages.dev. It may have moved, or`,
    "the link may be mistyped.",
    "",
    `Start from the [module picker](${SITE}/). Every published page is listed in the`,
    `[sitemap](${SITE}/sitemap.xml), and [llms.txt](${SITE}/llms.txt) explains what the site`,
    "does, when to use it and which JSON endpoints it answers.",
    ""
  );
}

export const NOT_ACCEPTABLE_MARKDOWN = lines(
  "# Not acceptable",
  "",
  "This site publishes HTML and Markdown. The request's `Accept` header excludes both, so no",
  "representation can be returned.",
  "",
  `Ask for \`text/html\` or \`text/markdown\`. The Markdown home page is at ${SITE}/index.md, and`,
  `${SITE}/llms.txt describes the site and its endpoints.`,
  ""
);

/* ---------------------------------------------------------------------------
 * Content negotiation (RFC 9110 §12.5.1).
 *
 * Markdown is selected only when `text/markdown` is named explicitly and its
 * quality is at least the quality of `text/html`. Browsers send HTML plus a
 * wildcard and keep getting HTML; curl's default wildcard does too. Wildcards
 * contribute quality but never select Markdown on their own.
 * ------------------------------------------------------------------------ */

function parseAccept(header) {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.trim().split(";");
      const [type, subtype] = rawType.trim().toLowerCase().split("/");
      if (!type || !subtype) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key && key.trim().toLowerCase() === "q") {
          const parsed = Number.parseFloat(value);
          q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
        }
      }
      return { type, subtype, q };
    })
    .filter(Boolean);
}

function qualityFor(type, subtype, ranges) {
  let best = null;
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best ? best.q : 0;
}

/**
 * @param {string | null} header the request's Accept header
 * @returns {"markdown" | "html" | "not-acceptable"}
 */
export function negotiate(header) {
  if (!header || !header.trim()) return "html";
  const ranges = parseAccept(header);
  if (ranges.length === 0) return "html";

  const namedMarkdown = ranges.some(
    (range) => range.type === "text" && range.subtype === "markdown"
  );
  const markdown = qualityFor("text", "markdown", ranges);
  const html = qualityFor("text", "html", ranges);

  if (namedMarkdown && markdown > 0 && markdown >= html) return "markdown";
  if (html > 0) return "html";
  if (!namedMarkdown && markdown > 0) return "markdown";
  return "not-acceptable";
}

export const DOCUMENTS = new Map([
  ["/", { markdown: HOME_MARKDOWN, alternate: "/index.md", file: "/index.html" }],
  ["/about", { markdown: ABOUT_MARKDOWN, alternate: "/about.md", file: "/about.html" }],
  ["/contact", { markdown: CONTACT_MARKDOWN, alternate: "/contact.md", file: "/contact.html" }],
  ["/privacy", { markdown: PRIVACY_MARKDOWN, alternate: "/privacy.md", file: "/privacy.html" }],
]);

export const MARKDOWN_ALIASES = new Map([
  ["/index.md", HOME_MARKDOWN],
  ["/about.md", ABOUT_MARKDOWN],
  ["/contact.md", CONTACT_MARKDOWN],
  ["/privacy.md", PRIVACY_MARKDOWN],
]);

/** Clean URLs are canonical; the `.html` files stay as aliases that redirect. */
export const HTML_ALIASES = new Map([
  ["/index.html", "/"],
  ["/about.html", "/about"],
  ["/contact.html", "/contact"],
  ["/privacy.html", "/privacy"],
]);

/** Add Accept to a Vary header without dropping what is already there. */
export function mergeVary(headers) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Accept");
    return headers;
  }
  if (current.trim() === "*") return headers;
  const values = current.split(",").map((value) => value.trim().toLowerCase());
  if (!values.includes("accept")) headers.set("Vary", `${current}, Accept`);
  return headers;
}

export function markdownResponse(body, status = 200, method = "GET") {
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
