// Service Worker: App offline startbar machen + letzten Stand zwischenspeichern.
const SHELL = "go-shell-v2";
const DATA = "go-data";
const IMAGES = "go-images";
const SHELL_FILES = ["/", "/app.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA, IMAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await caches.match("/")) || Response.error();
    throw new Error("offline");
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.startsWith("/api/img/")) {
    // Bilder ändern sich nie -> Cache zuerst
    e.respondWith(
      caches.open(IMAGES).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }))
    );
    return;
  }
  if (url.pathname === "/api/state") { e.respondWith(networkFirst(req, DATA)); return; }
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(networkFirst(req, SHELL));
});
