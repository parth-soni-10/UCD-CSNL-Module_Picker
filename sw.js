// CSNL Module Picker service worker — offline support.
//
// Strategy:
//   • App shell (HTML/CSS/JS/fonts/icons/manifest): stale-while-revalidate —
//     the cache answers instantly, the network refreshes it in the
//     background. The picker keeps its own data caches in localStorage, so
//     this only has to make repeat visits and offline loads instant.
//   • Function endpoints (/.netlify/functions/*): network-only. Timetable
//     and assessment data must be live; when offline the app already
//     degrades gracefully to its localStorage caches.
//   • Never cache POSTs or non-GET requests.
//
// Versioning. The cache is named after the `?v=` on this worker's own script
// URL, which app.js copies from its own <script> tag in index.html. Bumping
// that one query therefore installs a new worker AND renames this cache. An
// update waits for the visitor to choose "Update available → Reload"; the
// current shell remains usable until then.

const VERSION = (() => {
  try {
    return new URL(self.location.href).searchParams.get("v") || "1";
  } catch {
    return "1";
  }
})();

const CACHE = `csnl-picker-v${VERSION}`;

const SHELL = [
  "/",
  "/index.html",
  `/app.js?v=${VERSION}`,
  "/styles.css",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/modules.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/.netlify/functions/")) return; // always live

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // A navigation (a deep link such as "/?s=COMP30960") is keyed by pathname
      // only, so every deep link shares the one shell entry with "/" instead of
      // pinning a copy per query string. Every other request is keyed by
      // pathname *and* query, because the ?v= on app.js is a genuine version
      // marker: app.js?v=4 must never be answered from the app.js?v=3 entry.
      const isNavigation = req.mode === "navigate";
      const key = new Request(isNavigation ? url.pathname : url.pathname + url.search);
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached || (isNavigation ? cache.match("/index.html") : undefined));
      return cached || network;
    })
  );
});
