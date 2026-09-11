// Service Worker: App offline startbar machen + letzten Stand zwischenspeichern.
const SHELL = "go-shell-v4";
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
    const hit = await cache.match(req);
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

// ---------- Push-Benachrichtigungen ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Gruppenorganisator", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: d.tag,
      renotify: !!d.tag,
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        try { await c.focus(); return await c.navigate(url); } catch {}
      }
      return self.clients.openWindow(url);
    })
  );
});
