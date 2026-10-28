/**
 * Serve the staged upload locally through the real Pages Function router.
 *
 *   node tools/deploy-pages.mjs --assets . --out .pages-dist
 *   node tests/local-agent-server.mjs [port]
 *
 * This exists because `wrangler pages dev` does not start on every machine -
 * when workerd never answers, there is no way to check negotiation, 404s and
 * the trust pages against the files that will actually be uploaded. The pieces
 * that matter can be reproduced without workerd: the router is the same module
 * Pages compiles, `.pages-dist` is exactly the upload the deploy script makes,
 * and the `_headers` rule is applied the way the assets layer applies it.
 *
 * It is a development harness, not part of the site: `tests/` is in
 * `.assetsignore`, so it is never published.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import router from "../functions/_router.js";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DIST = join(ROOT, ".pages-dist");
const PORT = Number(process.argv[2] || 8789);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** The `/*` rule from _headers, which is the only rule this site has. */
async function headerRule() {
  const text = await readFile(join(DIST, "_headers"), "utf8");
  const headers = {};
  let active = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      active = trimmed === "/*";
      continue;
    }
    if (!active) continue;
    const index = trimmed.indexOf(":");
    if (index > 0) headers[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

function assetPath(pathname) {
  const clean = decodeURIComponent(pathname);
  const candidates = clean.endsWith("/")
    ? [join(clean, "index.html")]
    : [clean, `${clean}.html`];
  for (const candidate of candidates) {
    const file = resolve(join(DIST, candidate));
    if (file !== DIST && !file.startsWith(DIST + sep)) continue;
    if (existsSync(file)) return file;
  }
  return null;
}

async function readAsset(file) {
  const body = await readFile(file);
  return {
    body,
    type: TYPES[extname(file)] || "application/octet-stream",
  };
}

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    const file = assetPath(url.pathname);
    if (!file) {
      const notFound = await readFile(join(DIST, "404.html"));
      return new Response(notFound, {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const { body, type } = await readAsset(file);
    const headers = { "Content-Type": type };
    if (request.method === "HEAD") {
      headers["Content-Length"] = String(body.length);
    }
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  },
};

const env = { ASSETS, STORE_KV: { async get() { return null; }, async put() {} } };
const ctx = { waitUntil() {} };

const sharedHeaders = await headerRule();

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }

  try {
    const result = await router.fetch(
      new Request(url, { method: request.method, headers }),
      env,
      ctx
    );
    const body = request.method === "HEAD" ? null : Buffer.from(await result.arrayBuffer());
    const out = { ...sharedHeaders };
    for (const [name, value] of result.headers) out[name] = value;
    if (body) out["Content-Length"] = String(body.length);
    response.writeHead(result.status, out);
    response.end(body || undefined);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end(String((error && error.stack) || error));
  }
});

// Fail loudly if the upload was never staged: serving nothing would make every
// check look like a routing bug.
if (!existsSync(join(DIST, "index.html"))) {
  console.error("no .pages-dist; run node tools/deploy-pages.mjs --assets . --out .pages-dist");
  process.exit(1);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agent surface on http://127.0.0.1:${PORT} (serving ${DIST})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

