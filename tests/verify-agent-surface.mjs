/**
 * HTTP verification of the agent-facing surface.
 *
 *   node tests/local-agent-server.mjs 8789      # in another shell
 *   node tests/verify-agent-surface.mjs http://127.0.0.1:8789
 *
 * Every check is a real HTTP request, so it exercises the router, the staged
 * upload and the `_headers` rule together. Point it at the deployed origin to
 * repeat the same checks against production. Exits non-zero on any failure.
 */
const BASE = process.argv[2] || "http://127.0.0.1:8788";

let failures = 0;
const results = [];

function check(name, condition, detail = "") {
  if (condition) {
    results.push(`  PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures += 1;
    results.push(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function fetchPath(path, accept, method = "GET") {
  const headers = {};
  if (accept !== undefined) headers.Accept = accept;
  const response = await fetch(BASE + path, { method, headers, redirect: "manual" });
  const body = method === "HEAD" ? "" : await response.text();
  return { response, body, type: response.headers.get("content-type") || "" };
}

const probe = "/__ora-404-probe-caf7e05q";

// 1. Homepage negotiation ------------------------------------------------
{
  const md = await fetchPath("/", "text/markdown");
  check("GET / Accept: text/markdown → 200", md.response.status === 200, String(md.response.status));
  check("homepage markdown content type", /^text\/markdown; charset=utf-8$/.test(md.type), md.type);
  check("homepage markdown Vary: Accept", md.response.headers.get("vary") === "Accept", String(md.response.headers.get("vary")));
  check("homepage markdown body", md.body.startsWith("# CSNL Module Picker"), `${md.body.length} bytes`);
  check("homepage markdown has when-to-use", md.body.includes("## When to use this"));

  const html = await fetchPath("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  check("GET / Accept: text/html → 200", html.response.status === 200, String(html.response.status));
  check("homepage html content type", /^text\/html/.test(html.type), html.type);
  check("homepage html Vary includes Accept", /accept/i.test(String(html.response.headers.get("vary"))), String(html.response.headers.get("vary")));
  check("homepage html Link alternate", /<\/index\.md>; rel="alternate"/.test(String(html.response.headers.get("link"))), String(html.response.headers.get("link")));
  check("homepage html canonical", html.body.includes('<link rel="canonical" href="https://ucdcsnlmodulepicker.pages.dev/" />'));
  check("homepage html og:image", html.body.includes('property="og:image" content="https://ucdcsnlmodulepicker.pages.dev/og-image.png"'));
  check("homepage html og:type", html.body.includes('property="og:type" content="website"'));
  check("homepage html lang", html.body.includes('<html lang="en">'));
  check("homepage html JSON-LD", html.body.includes('"@type": "SoftwareApplication"') && html.body.includes('"contactPoint"'));
  check("homepage html footer links", ["/about", "/contact", "/privacy", "/llms.txt"].every((p) => html.body.includes(`href="${p}"`)));
  check("homepage CSP still applied", /script-src 'self'/.test(String(html.response.headers.get("content-security-policy"))));

  const dflt = await fetchPath("/", undefined);
  check("GET / default Accept stays HTML", /^text\/html/.test(dflt.type), dflt.type);
}

// 2. Trust pages ---------------------------------------------------------
for (const page of ["about", "contact", "privacy"]) {
  const md = await fetchPath(`/${page}`, "text/markdown");
  check(`/${page} markdown → 200`, md.response.status === 200 && /^text\/markdown/.test(md.type), `${md.response.status} ${md.type}`);
  check(`/${page} markdown body length`, md.body.length > 500, `${md.body.length} bytes`);

  const html = await fetchPath(`/${page}`, "text/html");
  check(`/${page} html → 200`, html.response.status === 200 && /^text\/html/.test(html.type), `${html.response.status} ${html.type}`);
  check(`/${page} html canonical`, html.body.includes(`href="https://ucdcsnlmodulepicker.pages.dev/${page}"`));
  check(`/${page} html CSP applied`, /script-src 'self'/.test(String(html.response.headers.get("content-security-policy"))));
}

// 3. Markdown aliases ----------------------------------------------------
for (const [alias, heading] of [
  ["/index.md", "# CSNL Module Picker"],
  ["/about.md", "# About CSNL Module Picker"],
  ["/contact.md", "# Contact CSNL Module Picker"],
  ["/privacy.md", "# Privacy"],
]) {
  const md = await fetchPath(alias, "text/html");
  check(`GET ${alias} → Markdown`, md.response.status === 200 && /^text\/markdown/.test(md.type) && md.body.startsWith(heading), `${md.response.status} ${md.type}`);
}

// 4. Clean URLs ----------------------------------------------------------
for (const [alias, target] of [
  ["/about.html", "/about"],
  ["/contact.html", "/contact"],
  ["/privacy.html", "/privacy"],
  ["/index.html", "/"],
]) {
  const redirect = await fetchPath(alias, "text/html");
  const location = redirect.response.headers.get("location") || "";
  check(`${alias} → 308 ${target}`, redirect.response.status === 308 && new URL(location).pathname === target, `${redirect.response.status} ${location}`);
}

// 5. 404 -----------------------------------------------------------------
{
  const md = await fetchPath(probe, "text/markdown");
  check("missing path markdown → 404", md.response.status === 404, String(md.response.status));
  check("missing path markdown type", /^text\/markdown; charset=utf-8$/.test(md.type), md.type);
  check("missing path markdown Vary", md.response.headers.get("vary") === "Accept", String(md.response.headers.get("vary")));
  check("missing path markdown explains", md.body.includes("Nothing is published at") && md.body.includes(probe), `${md.body.length} bytes`);
  check("missing path markdown links sitemap + llms", md.body.includes("sitemap.xml") && md.body.includes("llms.txt"));

  const html = await fetchPath(probe, "text/html");
  check("missing path html → 404", html.response.status === 404, String(html.response.status));
  check("missing path html body", /^text\/html/.test(html.type) && html.body.includes("That page does not exist"), `${html.type} ${html.body.length} bytes`);
  check("missing path html links agent files", html.body.includes('href="/sitemap.xml"') && html.body.includes('href="/llms.txt"'));
}

// 6. 406 and HEAD --------------------------------------------------------
{
  const refused = await fetchPath("/", "application/pdf");
  check("unacceptable Accept → 406", refused.response.status === 406 && /^text\/markdown/.test(refused.type), `${refused.response.status} ${refused.type}`);

  const head = await fetchPath("/", "text/markdown", "HEAD");
  check("HEAD / markdown", head.response.status === 200 && /^text\/markdown/.test(head.type), `${head.response.status} ${head.type}`);
}

// 7. Machine-readable files ---------------------------------------------
for (const [path, type, minBytes] of [
  ["/llms.txt", /^text\/plain/, 1500],
  ["/robots.txt", /^text\/plain/, 100],
  ["/sitemap.xml", /^(application|text)\/xml/, 300],
  ["/og-image.png", /^image\/png/, 20000],
  ["/pages.css", /^text\/css/, 1000],
  ["/about", /^text\/html/, 2000],
]) {
  const file = await fetchPath(path, undefined);
  check(`GET ${path} → 200 ${type}`, file.response.status === 200 && type.test(file.type) && file.body.length >= minBytes, `${file.response.status} ${file.type} ${file.body.length} bytes`);
}

// 8. JSON endpoints still work -------------------------------------------
{
  const api = await fetchPath("/.netlify/functions/timetable", "application/json");
  check("timetable endpoint still routes (400 without codes)", api.response.status === 400 && /^application\/json/.test(api.type), `${api.response.status} ${api.type}`);
  check("timetable error body", api.body.includes("No module codes supplied"), api.body.slice(0, 80));

  const health = await fetchPath("/.netlify/functions/catalogue?action=health", "application/json");
  let healthOk = false;
  try {
    const data = JSON.parse(health.body);
    healthOk = typeof data.ok === "boolean" && "warmed" in data;
  } catch {}
  check("catalogue health endpoint answers JSON", health.response.status === 200 && healthOk, `${health.response.status} ${health.body.slice(0, 90)}`);
}

// 9. The md files are not served as text/plain assets --------------------
{
  const asset = await fetchPath("/llms.txt", "text/markdown");
  check("llms.txt is never negotiated away", /^(text\/plain|text\/markdown)/.test(asset.type) && asset.body.startsWith("# CSNL Module Picker"), asset.type);
}

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
