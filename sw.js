// Service worker of the static export: caches the page shell for offline start.
const CACHE = "bat-signal-static-v3";
const SHELL = ["./", "index.html", "static/style.css", "static/wake_core.js", "static/wake.js",
  "static/icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then(async (response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      }
      return (response.status >= 500 && (await caches.match(event.request))) || response;
    }).catch(() => caches.match(event.request)));
});
