// Zero-dependency local dev server for the module picker.
//
//   node server.js          -> http://localhost:8787
//   PORT=9000 node server.js
//
// Serves the static site and mounts the Netlify timetable function at
// /.netlify/functions/timetable so the frontend code is identical locally
// and on Netlify.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handler: timetableHandler } = require("./netlify/functions/timetable.js");
const { handler: catalogueHandler } = require("./netlify/functions/catalogue.js");

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

  async function serveFunction(handler) {
    try {
      const event = {
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      };
      const result = await handler(event);
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  // Functions mounted at the same paths Netlify uses
  if (url.pathname === "/.netlify/functions/timetable") {
    await serveFunction(timetableHandler);
    return;
  }
  if (url.pathname === "/.netlify/functions/catalogue") {
    await serveFunction(catalogueHandler);
    return;
  }

  // Suggestions form (Netlify Forms): on Netlify the platform intercepts
  // the POST at "/" before this handler. Locally there is no form backend,
  // so log the submission and accept it so the flow is testable.
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const data = new URLSearchParams(body);
      console.log(`[suggestion] ${data.get("name") || "anonymous"}: ${data.get("suggestion") || "(empty)"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dev: true }));
    });
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
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Module picker running at http://localhost:${PORT}`);
  console.log(`Timetable function: http://localhost:${PORT}/.netlify/functions/timetable?codes=COMP30960`);
  console.log(`Catalogue function: http://localhost:${PORT}/.netlify/functions/catalogue`);
});
