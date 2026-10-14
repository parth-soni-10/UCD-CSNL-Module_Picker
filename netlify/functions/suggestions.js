// Suggestions from the module picker's form.
//
// This replaced the host's own form handling. The form used to be a
// `data-netlify="true"` form: the platform scanned the markup on deploy,
// intercepted the POST at "/" and filed it in a dashboard. Nothing scans markup
// on Cloudflare and nothing intercepts "/", so the same form was POSTing into
// an asset layer that answers 405 — accepted by the browser, stored nowhere.
// The submission now comes here instead, through the Worker the way every other
// endpoint in this repo does.
//
// Storage is the same injected backend the catalogue and assessments use
// (`setStore()` from worker.js, a KV namespace in production and an in-memory
// map on the local server), under its own store name so a suggestion can never
// collide with a cached catalogue. The shape kept is a list, newest last,
// capped, because the useful question is "what have people asked for" and not
// "what is the latest row".
//
// Nothing reads these back over HTTP, deliberately: a submission carries a name
// and an email address. They are readable with the binding, which is the access
// a public route would have to be guarded to match:
//
//   npx wrangler kv key get --binding STORE_KV "csnl-suggestions/list" --remote
//
// Honest ceiling, same as the throttles in the Content Tracker: KV has no append
// and no compare-and-swap, so two submissions arriving in the same instant can
// read the same list and the later write wins. At this site's volume that is a
// race nobody can lose twice; if it ever matters, the fix is one D1 table.
//
// Two shapes come out of this one endpoint. The app's fetch gets JSON; a browser
// that navigated here — the form's own `action`, which is what a submit made
// without app.js's handler now resolves to — gets a small HTML page, because a
// navigation asks for text/html and fetch asks for anything. That page carries
// its own headers: a response this Worker generates never passes through the
// static assets layer, so the site's `_headers` file does not apply to it
// (measured: this endpoint answers with no CSP, while /styles.css answers with
// the site's). `style-src 'self'` there is why the page links the stylesheet
// rather than carrying any inline styling.

"use strict";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_KEPT = 500;
const MAX_NAME = 80;
const MAX_EMAIL = 160;
const MAX_TEXT = 1000;

const STORE_NAME = "csnl-suggestions";
const KEY = "list";

// Injected by whichever host runs this module (see catalogue.js for the same
// seam). No backend means no durable store: the request still succeeds, and the
// submission is logged rather than lost silently, because a form that says
// "on its way" while writing nowhere is the failure this file exists to end.
let storeBackend = null;

function setStore(backend) {
  storeBackend = backend;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
  body: JSON.stringify(body),
});

/** Parse what the browser sent. The form is urlencoded; JSON is accepted too so
    a caller does not have to know which shape this endpoint was written for. */
function readBody(event) {
  const raw = typeof event.body === "string" ? event.body : "";
  if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  const contentType = String((event.headers && (event.headers["content-type"] || event.headers["Content-Type"])) || "");
  if (/application\/json/i.test(contentType)) {
    try {
      return { fields: JSON.parse(raw) };
    } catch {
      return { malformed: true };
    }
  }
  const params = new URLSearchParams(raw);
  const fields = {};
  for (const [key, value] of params) fields[key] = value;
  return { fields };
}

const clean = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

// What the receipt says on success. It is the same promise the app's own success
// note makes in index.html, because it is the same answer.
const RECEIPT =
  "Thanks. Your suggestion is on its way. If you left an email, you'll hear back once it's addressed.";

/** Is this a browser navigating to the form's action, rather than the app's own
    fetch()? A form submit asks for text/html by name; fetch asks for anything.
    That is the whole test, so the form carries no flag saying which path it is. */
function wantsHtml(event) {
  const headers = event.headers || {};
  return /text\/html/i.test(String(headers.accept || headers.Accept || ""));
}

// Nothing from a submission is echoed into the page — only fixed sentences and
// a count — so this escapes for the day that stops being true. An apostrophe is
// left alone: it is safe in text content, and "you'll" should not arrive at the
// reader as an entity.
const escapeHtml = (value) =>
  String(value).replace(/[&<>\"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

/** Headers for that page. This response is generated by the Worker, so the site's
    `_headers` rules never reach it — the policy has to be stated here. It is
    narrower than the site's, because this page runs no script at all. */
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The page a native submit lands on, instead of the 405 it used to get. */
function receiptPage({ ok, message }) {
  const title = ok ? "Suggestion received" : "Suggestion not sent";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — CSNL Module Picker</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="suggest-receipt">
  <div class="panel">
    <h1>${title}</h1>
    <p class="plan-hint">${escapeHtml(message)}</p>
    <p class="suggest-receipt-links">
      <a class="btn btn-secondary" href="/">Back to the module picker</a>
      ${ok ? "" : '<a class="btn btn-ghost" href="/#suggest-text">Try again</a>'}
    </p>
  </div>
</main>
</body>
</html>
`;
}

const page = (statusCode, receipt) => ({
  statusCode,
  headers: { ...PAGE_HEADERS },
  body: receiptPage(receipt),
});

exports.handler = async (event) => {
  // One decision, made once: a navigation is answered with a page, the app's
  // fetch with JSON. Every exit below goes through one of these two.
  const asPage = wantsHtml(event);
  const refuse = (status, error) =>
    asPage ? page(status, { ok: false, message: error }) : json(status, { error });
  const succeed = (total) =>
    asPage
      ? page(200, {
          ok: true,
          message: total == null ? RECEIPT : `${RECEIPT} ${total} stored so far.`,
        })
      : json(200, total == null ? { ok: true } : { ok: true, total });

  if (event.httpMethod !== "POST") return refuse(405, "Method not allowed");

  const { fields, malformed, tooLarge } = readBody(event);
  if (tooLarge) return refuse(413, "That suggestion is too long to accept.");
  if (malformed) return refuse(400, "Could not read the submission.");

  // The honeypot the form used to carry for the old host is still here, still
  // hidden, and now read by us: a filled one is answered exactly like a real
  // submission and dropped, so a script that looks for a distinguishing reply
  // learns nothing. This is the whole anti-spam measure, and it is worth saying
  // so — it stops form-filling robots, not a determined person.
  if (clean(fields["bot-field"], 100)) return succeed(null);

  const suggestion = clean(fields.suggestion, MAX_TEXT);
  if (suggestion.length < 3) return refuse(400, "Write a suggestion first.");

  const email = clean(fields.email, MAX_EMAIL);
  if (email && !EMAIL_RE.test(email)) return refuse(400, "That email address does not look right.");

  const record = {
    name: clean(fields.name, MAX_NAME),
    email,
    suggestion,
    sentAt: new Date().toISOString(),
  };

  if (!storeBackend) {
    console.log("[suggestion] no store backend wired —", JSON.stringify(record));
    return succeed(null);
  }

  try {
    const existing = (await storeBackend.get(STORE_NAME, KEY)) || [];
    const list = (Array.isArray(existing) ? existing : []).concat([record]).slice(-MAX_KEPT);
    await storeBackend.set(STORE_NAME, KEY, list);
    return succeed(list.length);
  } catch (error) {
    console.error("Suggestion write failed:", (error && error.stack) || error);
    return refuse(502, "Could not save that suggestion. Try again in a moment.");
  }
};

exports.setStore = setStore;
