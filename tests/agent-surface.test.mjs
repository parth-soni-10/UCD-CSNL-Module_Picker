/**
 * Agent-surface tests for CSNL Module Picker.
 *
 *   node --test tests/agent-surface.test.mjs
 *
 * The router takes `env` as an argument, so the ASSETS stub below exercises the
 * real negotiation, alias, redirect and 404 contract without Wrangler or UCD.
 * Everything else here reads the files that actually get uploaded — metadata,
 * trust pages, sitemap, llms.txt, robots.txt and the social card — so a change
 * that would only fail in production fails here instead.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ABOUT_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCUMENTS,
  HOME_MARKDOWN,
  HTML_ALIASES,
  MARKDOWN_ALIASES,
  PRIVACY_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "../functions/_agent-docs.js";
import router from "../functions/_router.js";

const ROOT = new URL("../", import.meta.url);
const SITE = "https://ucdcsnlmodulepicker.pages.dev";

const read = (name) => readFile(new URL(name, ROOT), "utf8");

/** Text a crawler sees, with scripts, styles and tags removed. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HTML_PAGE = (title, extra = "") =>
  new Response(
    `<!doctype html><html lang="en"><body><h1>${title}</h1>${extra}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

const NOT_FOUND_PAGE = '<!doctype html><html lang="en"><body><h1>Page not found</h1></body></html>';

/** The assets layer, deliberately resolving `/about` itself but not `/contact`,
 *  so both the direct hit and the `.html` fallback are covered. */
function assetsStub() {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") return HTML_PAGE("CSNL Module Picker");
      if (path === "/about.html") return HTML_PAGE("About");
      if (path === "/contact") return HTML_PAGE("Contact");
      if (path === "/privacy.html") return HTML_PAGE("Privacy");
      if (path === "/llms.txt") {
        return new Response("# CSNL Module Picker\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(NOT_FOUND_PAGE, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}

const env = {
  ASSETS: assetsStub(),
  STORE_KV: {
    async get() {
      return null;
    },
    async put() {},
  },
};

const ctx = { waitUntil() {} };

const get = (path, accept, method = "GET") => {
  const headers = accept === undefined ? {} : { Accept: accept };
  return router.fetch(new Request(`${SITE}${path}`, { method, headers }), env, ctx);
};

/* ----------------------------------------------------------- negotiation */

test("negotiation keeps browsers and wildcards on HTML", () => {
  assert.equal(negotiate(null), "html");
  assert.equal(negotiate(""), "html");
  assert.equal(negotiate("*/*"), "html");
  assert.equal(negotiate("text/html,*/*;q=0.8"), "html");
  assert.equal(
    negotiate("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    "html"
  );
  assert.equal(negotiate("text/markdown"), "markdown");
  assert.equal(negotiate("text/markdown, text/html;q=0.5"), "markdown");
  // Equal quality: an agent that names Markdown at all gets Markdown.
  assert.equal(negotiate("text/html, text/markdown"), "markdown");
  assert.equal(negotiate("text/html;q=1, text/markdown;q=0.8"), "html");
  assert.equal(negotiate("text/markdown;q=0.9, text/html;q=0.9"), "markdown");
  assert.equal(negotiate("application/pdf"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0"), "not-acceptable");
});

test("negotiation on the homepage returns Markdown with Vary", async () => {
  const response = await get("/", "text/markdown");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown; charset=utf-8$/);
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.ok(body.startsWith("# CSNL Module Picker"), body.slice(0, 60));
  assert.ok(body.includes("## When to use this"));
  assert.ok(body.length > 1500, `body too short: ${body.length}`);
});

test("negotiation on the homepage keeps HTML for browsers", async () => {
  const response = await get("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary"), /\bAccept\b/);
  assert.match(response.headers.get("Link") || "", /<\/index\.md>; rel="alternate"/);
  assert.match(response.headers.get("Link") || "", /llms\.txt/);
});

test("HEAD returns the Markdown type with no body", async () => {
  const response = await get("/", "text/markdown", "HEAD");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown/);
  assert.equal(await response.text(), "");
});

test("an unacceptable Accept is answered 406 as Markdown", async () => {
  const response = await get("/", "application/pdf");
  assert.equal(response.status, 406);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown/);
  assert.match(await response.text(), /Not acceptable/);
});

/* --------------------------------------------------------------- aliases */

test("every .md alias returns Markdown without negotiation", async () => {
  for (const [path, document] of MARKDOWN_ALIASES) {
    const response = await get(path, "text/html");
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("Content-Type"), /^text\/markdown/, path);
    assert.equal(await response.text(), document, path);
  }
});

test("the trust pages negotiate Markdown and serve HTML", async () => {
  for (const path of ["/about", "/contact", "/privacy"]) {
    const markdown = await get(path, "text/markdown");
    assert.equal(markdown.status, 200, path);
    assert.match(markdown.headers.get("Content-Type"), /^text\/markdown/, path);
    assert.ok((await markdown.text()).length > 500, path);

    const html = await get(path, "text/html");
    assert.equal(html.status, 200, path);
    assert.match(html.headers.get("Content-Type"), /^text\/html/, path);
    assert.equal(html.headers.get("Vary"), "Accept", path);
  }
});

test("the .html files redirect to their clean URL", async () => {
  for (const [alias, canonical] of HTML_ALIASES) {
    const response = await get(alias, "text/html");
    assert.equal(response.status, 308, alias);
    assert.equal(new URL(response.headers.get("Location")).pathname, canonical, alias);
  }
});

/* ------------------------------------------------------------------- 404 */

test("a missing path asked for Markdown returns 404 with a Markdown body", async () => {
  const response = await get("/__ora-404-probe-caf7e05q", "text/markdown");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown; charset=utf-8$/);
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.ok(body.length > 60, `too short: ${body.length}`);
  assert.match(body, /__ora-404-probe-caf7e05q/);
  assert.match(body, /Page not found/);
  assert.match(body, /sitemap\.xml/);
  assert.match(body, /llms\.txt/);
  assert.doesNotMatch(body, /<html/i);
});

test("a missing path for a browser keeps the HTML 404", async () => {
  const response = await get("/__ora-404-probe-caf7e05q", "text/html");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.equal(await response.text(), NOT_FOUND_PAGE);
});

test("the 404 body is safe when the path contains backticks", () => {
  assert.match(notFoundMarkdown("/a`b"), /a'b/);
});

/* --------------------------------------------------------------- routing */

test("the JSON endpoints still route past the agent layer", async () => {
  const response = await get("/.netlify/functions/timetable", "text/html");
  assert.equal(response.status, 400);
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  assert.match(await response.text(), /No module codes supplied/);
});

test("the markdown helper merges Vary instead of replacing it", () => {
  const headers = new Headers({ Vary: "Accept-Encoding" });
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  const wildcard = new Headers({ Vary: "*" });
  mergeVary(wildcard);
  assert.equal(wildcard.get("Vary"), "*");
});

test("markdownResponse strips the body on HEAD", async () => {
  const response = markdownResponse("# hi\n", 200, "HEAD");
  assert.equal(await response.text(), "");
});

/* ------------------------------------------------------------------ docs */

test("the documents describe endpoints that exist in the router", async () => {
  const routerSource = await read("functions/_router.js");
  for (const endpoint of [
    "/.netlify/functions/catalogue",
    "/.netlify/functions/timetable",
    "/.netlify/functions/assessments",
    "/.netlify/functions/suggestions",
  ]) {
    assert.ok(routerSource.includes(endpoint), `router is missing ${endpoint}`);
    assert.ok(HOME_MARKDOWN.includes(endpoint), `home Markdown is missing ${endpoint}`);
    assert.ok((await read("llms.txt")).includes(endpoint), `llms.txt is missing ${endpoint}`);
  }
  assert.ok(HOME_MARKDOWN.includes("## When to use this"));
  assert.ok((await read("llms.txt")).includes("## When to use this"));
});

test("each document is substantial and internally consistent", () => {
  for (const [path, doc] of DOCUMENTS) {
    assert.ok(doc.markdown.length > 500, path);
    assert.ok(doc.markdown.startsWith("# "), path);
    assert.equal(MARKDOWN_ALIASES.get(doc.alternate), doc.markdown, path);
  }
  for (const doc of [ABOUT_MARKDOWN, CONTACT_MARKDOWN, PRIVACY_MARKDOWN]) {
    assert.match(doc, /soni\.soni\.parth@gmail\.com/);
  }
});

/* -------------------------------------------------------------- metadata */

test("the homepage carries every metadata signal an agent checks", async () => {
  const html = await read("index.html");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ucdcsnlmodulepicker\.pages\.dev\/" \/>/);
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/ucdcsnlmodulepicker\.pages\.dev\/og-image\.png" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  assert.match(html, /<meta property="og:site_name" content="CSNL Module Picker" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/ucdcsnlmodulepicker\.pages\.dev\/" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/index\.md" \/>/);
  assert.match(html, /<title>CSNL Module Picker — UCD CS Timetable Builder<\/title>/);
});

test("the homepage JSON-LD is valid and complete", async () => {
  const html = await read("index.html");
  const match = html.match(
    /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/
  );
  assert.ok(match, "no JSON-LD block");
  const data = JSON.parse(match[1]);
  assert.equal(data["@context"], "https://schema.org");

  const nodes = data["@graph"];
  assert.ok(Array.isArray(nodes));

  const organization = nodes.find((node) => node["@type"] === "Organization");
  const website = nodes.find((node) => node["@type"] === "WebSite");
  const app = nodes.find((node) => node["@type"] === "SoftwareApplication");
  assert.ok(organization, "Organization missing");
  assert.ok(website, "WebSite missing");
  assert.ok(app, "SoftwareApplication missing");

  assert.equal(app.name, "CSNL Module Picker");
  assert.equal(app.url, `${SITE}/`);
  assert.ok(app.description.length > 40);
  assert.equal(app.applicationCategory, "EducationalApplication");
  assert.equal(app.isAccessibleForFree, true);
  assert.equal(app.offers.price, "0");

  assert.equal(organization.contactPoint["@type"], "ContactPoint");
  assert.match(organization.contactPoint.email, /@/);
  assert.ok(organization.contactPoint.contactType);
  assert.equal(organization.address["@type"], "PostalAddress");
  assert.ok(organization.address.addressCountry);
  assert.ok(organization.address.addressLocality);
  assert.ok(organization.sameAs.length >= 1);
});

test("the social card is a 1200x630 PNG", async () => {
  const png = await readFile(new URL("og-image.png", ROOT));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length > 20000, `card looks empty: ${png.length} bytes`);
});

/* ------------------------------------------------------- trust and files */

test("the trust pages carry real content and navigation", async () => {
  for (const [file, canonical, markdownAlias] of [
    ["about.html", `${SITE}/about`, "/about.md"],
    ["contact.html", `${SITE}/contact`, "/contact.md"],
    ["privacy.html", `${SITE}/privacy`, "/privacy.md"],
  ]) {
    const html = await read(file);
    assert.match(html, /<html lang="en">/, file);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}" />`), file);
    assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${markdownAlias}" />`), file);
    assert.ok(html.includes('name="description"'), file);
    assert.ok(html.includes('property="og:image"'), file);
    assert.ok(visibleText(html).length >= 500, `${file} has too little text`);

    // Every trust page links the other two, so none is a dead end.
    for (const other of ["/about", "/contact", "/privacy"]) {
      assert.ok(html.includes(`href="${other}"`), `${file} does not link ${other}`);
    }
    assert.doesNotMatch(html, /\sstyle="/, file);
  }
});

test("the 404 page is real and points at the machine-readable files", async () => {
  const html = await read("404.html");
  assert.ok(visibleText(html).length > 300);
  assert.ok(html.includes('href="/sitemap.xml"'));
  assert.ok(html.includes('href="/llms.txt"'));
  assert.match(html, /noindex/);
});

test("the sitemap lists every published page", async () => {
  const sitemap = await read("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations.sort(), [
    `${SITE}/`,
    `${SITE}/about`,
    `${SITE}/contact`,
    `${SITE}/privacy`,
  ].sort());
  for (const html of ["about.html", "contact.html", "privacy.html"]) {
    const canonical = (await read(html)).match(/rel="canonical" href="([^"]+)"/)[1];
    assert.ok(locations.includes(canonical), `${html} canonical is not in the sitemap`);
  }
});

test("robots.txt and the machine-readable files agree on the sitemap", async () => {
  const robots = await read("robots.txt");
  assert.match(robots, /Sitemap: https:\/\/ucdcsnlmodulepicker\.pages\.dev\/sitemap\.xml/);
  assert.match(robots, /User-agent: \*/);
  const llms = await read("llms.txt");
  assert.ok(llms.startsWith("# CSNL Module Picker"));
  assert.ok(llms.includes("> "), "llms.txt needs the summary blockquote");
  assert.ok(llms.includes(`${SITE}/sitemap.xml`));
});

test("the trust pages are not excluded from the upload", async () => {
  const ignore = await read(".assetsignore");
  const rules = ignore
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  for (const file of ["about.html", "contact.html", "privacy.html", "404.html", "llms.txt", "og-image.png", "pages.css"]) {
    assert.ok(!rules.includes(file), `${file} would not be uploaded`);
  }
  assert.ok(rules.includes("tests/"), "tests/ must not be uploaded");
});
