/**
 * CFI Terminal — Service Worker
 * Scoped to /cfi-dashboard/ for GitHub Pages subdirectory
 */

const CACHE_NAME = "cfi-terminal-v2";
const BASE = "/cfi-dashboard/";

const ASSETS = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.json",
  BASE + "icon-180.jpg",
  BASE + "icon-192.jpg",
  BASE + "icon-512.jpg",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.url.includes("api.telegram.org")) return;
  if (event.request.url.includes("stooq.com")) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
