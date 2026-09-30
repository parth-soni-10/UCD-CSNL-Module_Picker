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

const CACHE = "csnl-picker-v2";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon.svg",
  "/modules.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
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
      // Cache key = pathname only. Deep links ("/?s=…") must share the shell
      // cache with "/", not pin whatever asset version was current when that
      // exact query string was first seen.
      const key = new Request(url.pathname);
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
