// Zero-dependency local dev server for the module picker.
//
//   node server.js          -> http://localhost:8787
//   PORT=9000 node server.js
//
// Serves the static site and mounts the timetable function (and its siblings) at
// the same /.netlify/functions/* paths production serves, so the frontend code
// is identical locally and deployed.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handler: timetableHandler } = require("./netlify/functions/timetable.js");
const { handler: catalogueHandler } = require("./netlify/functions/catalogue.js");
const { handler: assessmentsHandler } = require("./netlify/functions/assessments.js");
const { handler: suggestionsHandler } = require("./netlify/functions/suggestions.js");

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || "8787", 10) || 8787;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  function readBody(req) {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });
  }

  async function serveFunction(handler) {
    try {
      const event = {
        httpMethod: req.method,
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
        // `accept` travels too, because the suggestions endpoint answers a
        // navigation with a page and the app's fetch with JSON; dropping it
        // here would make the local server the one place a native submit looks
        // like a fetch.
        headers: {
          "content-type": req.headers["content-type"] || "",
          accept: req.headers.accept || "",
        },
      };
      // Only the suggestions endpoint reads a body, and reading it eagerly for
      // every request would leave the handlers that do not care waiting on it.
      if (req.method !== "GET" && req.method !== "HEAD") event.body = await readBody(req);
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  // Functions mounted at the same paths production serves
  if (url.pathname === "/.netlify/functions/timetable") {
    await serveFunction(timetableHandler);
    return;
  }
  if (url.pathname === "/.netlify/functions/catalogue") {
    await serveFunction(catalogueHandler);
    return;
  }
  if (url.pathname === "/.netlify/functions/assessments") {
    await serveFunction(assessmentsHandler);
    return;
  }
  // The suggestions form posts here, exactly as it does in production. No store
  // backend is wired locally, so the handler logs the submission and accepts
  // it - the flow is testable without a KV namespace on this machine.
  if (url.pathname === "/.netlify/functions/suggestions") {
    await serveFunction(suggestionsHandler);
    return;
  }

  // Static files
  let filePath = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
  // basic traversal guard
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // fall back to index.html for unknown paths (SPA-lite)
      filePath = path.join(ROOT, "index.html");
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // HTML must always revalidate (it references versioned scripts);
      // other assets may live briefly in the browser cache.
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Module picker running at http://localhost:${PORT}`);
  console.log(`Timetable function: http://localhost:${PORT}/.netlify/functions/timetable?codes=COMP30960`);
  console.log(`Catalogue function: http://localhost:${PORT}/.netlify/functions/catalogue`);
  console.log(`Assessments function: http://localhost:${PORT}/.netlify/functions/assessments`);
  console.log(`Suggestions endpoint:  http://localhost:${PORT}/.netlify/functions/suggestions`);
});
