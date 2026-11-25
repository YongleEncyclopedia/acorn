/*
 * Acorn service worker: the app shell, articles and pictures seen recently, and the offline pack (离线包) that
 * web/src/lib/offline.ts stores on purpose. When the server cannot be reached, answers come from what is stored,
 * marked with an `x-acorn-cached` header (the server's Date of that copy) so the page can say it is offline.
 */
const VERSION = "acorn-v1";
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;
const MEDIA = `${VERSION}-media`;
/** The offline pack: filled by the page, never trimmed here (a new pack replaces the old one). */
const OFFLINE = `${VERSION}-offline`;
/** In OFFLINE: srcset candidates the pack did not store, mapped to the stored picture of the same image. */
const ALIASES = "/__acorn/offline/aliases.json";
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

const stamp = (res) => Date.parse((res && res.headers.get("date")) || "") || 0;

/** A stored copy, marked so the page knows it is reading from this device rather than from the server. */
function fromDevice(res) {
  const headers = new Headers(res.headers);
  headers.set("x-acorn-cached", String(stamp(res)));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The newest stored copy: browsing after the pack was made keeps newer copies in PAGES. */
async function stored(req, cacheName) {
  const a = await (await caches.open(cacheName)).match(req);
  const b = await (await caches.open(OFFLINE)).match(req, { ignoreVary: true });
  if (!a || !b) return a || b;
  return stamp(b) > stamp(a) ? b : a;
}

// After a request could not reach the server, the next ones wait less before answering from this device: on a
// weak signal every screen would otherwise sit through the full timeout of each of its requests.
let failedAt = 0;
const patience = (ms) => (Date.now() - failedAt < 60_000 ? Math.min(ms, 1500) : ms);

async function networkFirst(req, cacheName, timeoutMs, max = 0) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), patience(timeoutMs)))]);
    failedAt = 0;
    if (res.ok) {
      await cache.delete(req); // re-insert so the newest stays at the end of the key list
      await cache.put(req, res.clone());
      if (max) trim(cacheName, max);
    }
    return res;
  } catch (err) {
    failedAt = Date.now();
    const hit = await stored(req, cacheName);
    if (hit) return fromDevice(hit);
    throw err;
  }
}

/**
 * The app's pages are one page that routes in the browser: one copy is kept, the newest, under "/". (A copy per
 * address would go stale with each new version and point at code that is no longer stored.)
 */
async function appPage(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), patience(4000)))]);
    failedAt = 0;
    if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) await cache.put("/", res.clone());
    return res;
  } catch (err) {
    failedAt = Date.now();
    const hit = await cache.match("/");
    if (hit) return hit;
    throw err;
  }
}

/** The app's own files: named by their content, so a stored copy is always right. */
async function shell(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/** Pictures and icons: the pack's copy, then a recent one, then the network. */
async function media(req) {
  const offline = await caches.open(OFFLINE);
  const cache = await caches.open(MEDIA);
  const hit = (await offline.match(req, { ignoreVary: true })) || (await cache.match(req));
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trim(MEDIA, MEDIA_MAX);
    }
    return res;
  } catch (err) {
    // another size of a picture the pack stored (the browser chooses from srcset by screen): show the stored one
    const url = new URL(req.url);
    const map = await offline.match(ALIASES).then((r) => (r ? r.json() : {}), () => ({}));
    const alias = map[url.pathname + url.search];
    const stand = alias && ((await offline.match(alias, { ignoreVary: true })) || (await cache.match(alias)));
    if (stand) return stand;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // the offline pack downloads with this header and stores what it gets itself: straight to the network
  if (req.headers.has("x-acorn-offline")) return;
  const p = url.pathname;
  if (p === "/api/events" || p.startsWith("/reader/") || p.startsWith("/accounts/")) return;

  if (req.mode === "navigate") {
    // archived pages (离线阅读页) are pages of their own, kept by address like the API's answers
    event.respondWith(p.startsWith("/files/") ? networkFirst(req, PAGES, 6000, PAGES_MAX) : appPage(req));
    return;
  }
  if (p.startsWith("/assets/")) {
    event.respondWith(shell(req));
    return;
  }
  if (p === "/api/img" || p.startsWith("/files/archive/") || p.startsWith("/api/icons/")) {
    event.respondWith(media(req));
    return;
  }
  // /api/session too: without it the app cannot even start offline (it asks who is signed in first)
  if (/^\/api\/(entries|archives)\/\d+$/.test(p) || p === "/api/session" || p === "/api/bootstrap" || p === "/api/entries" || p === "/api/archives" || p === "/api/highlights") {
    event.respondWith(networkFirst(req, PAGES, 6000, PAGES_MAX));
  }
});
