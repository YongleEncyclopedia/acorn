/* Acorn service worker: offline app shell, cached articles and images. */
const VERSION = "acorn-v1";
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;
const MEDIA = `${VERSION}-media`;
const MEDIA_MAX = 800;
const PAGES_MAX = 400; // every list query is its own cache entry; keep the newest

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function networkFirst(req, cacheName, timeoutMs, max = 0) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
    if (res.ok) {
      await cache.delete(req); // re-insert so the newest stays at the end of the key list
      await cache.put(req, res.clone());
      if (max) trim(cacheName, max);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone());
    trim(cacheName, MEDIA_MAX);
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p === "/api/events" || p.startsWith("/reader/") || p.startsWith("/accounts/")) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, SHELL, 4000).catch(() => caches.match("/")));
    return;
  }
  if (p.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req, SHELL));
    return;
  }
  if (p === "/api/img" || p.startsWith("/files/archive/") || p.startsWith("/api/icons/")) {
    event.respondWith(cacheFirst(req, MEDIA));
    return;
  }
  if (/^\/api\/(entries|archives)\/\d+$/.test(p) || p === "/api/bootstrap" || p === "/api/entries" || p === "/api/archives" || p === "/api/highlights") {
    event.respondWith(networkFirst(req, PAGES, 6000, PAGES_MAX));
  }
});

/** Offline pack: the page posts a list of URLs to cache (entries + their images). */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "prefetch") return;
  event.waitUntil(
    (async () => {
      const pages = await caches.open(PAGES);
      const media = await caches.open(MEDIA);
      for (const u of event.data.urls || []) {
        try {
          const res = await fetch(u, { credentials: "same-origin" });
          if (res.ok) await (u.includes("/api/img") || u.includes("/files/") ? media : pages).put(u, res);
        } catch {
          /* skip */
        }
      }
    })(),
  );
});
