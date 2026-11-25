/**
 * 离线包: articles, their pictures and the app itself, stored on this device to read where there is no
 * connection (in the mountains, on a plane). Everything is fetched at the address the reader will use later (the
 * same list pages, the same picture URLs), so the service worker (web/public/sw.js) can answer from what is stored
 * when the server cannot be reached. Pictures and app files stored before are not fetched again; a new pack
 * replaces the old one only once it is complete. Changes made while offline are handled by lib/outbox.ts.
 */
import { useEffect, useState } from "react";
import { api, entriesPath, imageProxy, listQuery, type EntryQuery } from "./api.ts";
import { getLocal, setLocal, useLocal } from "./local.ts";
import { articleImages } from "../../../src/shared/offline.ts";
import type { Bootstrap, Entry, EntrySummary, Page } from "../../../src/shared/types.ts";

// the service worker's caches (web/public/sw.js)
const OFFLINE = "acorn-v1-offline";
const SHELL = "acorn-v1-shell";
const MEDIA = "acorn-v1-media";
const PAGES = "acorn-v1-pages";
const ALIASES = "/__acorn/offline/aliases.json";
const INFO = "acorn.offline.pack";

export interface PackOptions {
  /** How many unread articles, in the order the 未读 list shows them. 稍后读 and 在读 always come along. */
  unread: number;
  images: boolean;
  /** The reading font chosen in 阅读外观 (宋体 or 文楷), so text looks the same offline. */
  fonts: boolean;
}

export interface PackInfo {
  at: number;
  articles: number;
  images: number;
  /** Pictures left out: their site did not answer, or the server could not get them. */
  skipped?: number;
  /** Downloaded for this pack; what was stored already is not counted again. */
  bytes: number;
  /** false: it stopped before the end, and `note` says why. */
  complete: boolean;
  note?: string;
}

export interface PackProgress {
  stage: "app" | "lists" | "articles" | "finishing";
  done: number;
  total: number;
  bytes: number;
}

/** Why this device cannot keep an offline pack; null when it can. */
export function offlineBlocker(): "dev" | "insecure" | "unsupported" | null {
  if (!import.meta.env.PROD) return "dev";
  // browsers only let https pages (and localhost) store an app for offline use
  if (!window.isSecureContext) return "insecure";
  if (!("caches" in window) || !("serviceWorker" in navigator)) return "unsupported";
  return null;
}

export function usePackInfo(): PackInfo | null {
  const [raw] = useLocal(INFO, "");
  try {
    return raw ? (JSON.parse(raw) as PackInfo) : null;
  } catch {
    return null;
  }
}

/** How much this site stores on the device, and how much more it may. */
export function useStorage(deps: unknown[]): { usage: number; quota: number } | null {
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    void navigator.storage?.estimate?.().then(
      (e) => setEst(e.quota ? { usage: e.usage ?? 0, quota: e.quota } : null),
      () => setEst(null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return est;
}

export async function clearPack(): Promise<void> {
  await caches.delete(OFFLINE);
  setLocal(INFO, "");
}

/** Signing out: the articles and pictures this device stored go with it (the app's own files stay). */
export async function forgetStored(): Promise<void> {
  if ("caches" in window) await Promise.all([OFFLINE, PAGES, MEDIA].map((name) => caches.delete(name)));
  setLocal(INFO, "");
}

class Stopped extends Error {}

/** The server could not be reached at all: the connection dropped. */
class Unreachable extends Error {}

/** One item the server would not give (gone, failed): the pack goes on without it. */
class Missing extends Error {}

/** Run `fn` over `items`, `limit` at a time; after a failure no new item starts, and the failure is thrown. */
async function each<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < items.length && failure === null) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        if (!(err instanceof Missing)) failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure;
}

const pathOf = (url: string): string => {
  const u = new URL(url, window.location.origin);
  return u.pathname + u.search;
};

export async function downloadPack(opts: PackOptions, onProgress: (p: PackProgress) => void, signal: AbortSignal): Promise<PackInfo> {
  // the service worker answers offline: it has to be running before anything is worth storing
  await navigator.serviceWorker.ready;
  void navigator.storage?.persist?.().catch(() => false); // installed web apps get storage the browser does not clear
  const offline = await caches.open(OFFLINE);
  const shell = await caches.open(SHELL);
  const media = await caches.open(MEDIA);
  const keep = new Set<string>([ALIASES]); // what this pack keeps in OFFLINE; the rest of the old pack goes at the end
  const aliases: Record<string, string> = {};
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  const room = est?.quota ? (est.quota - (est.usage ?? 0)) * 0.9 : Infinity;
  let bytes = 0;
  let images = 0;
  let articles = 0;
  let skipped = 0;
  let note: string | undefined;
  let stage: PackProgress["stage"] = "app";
  const report = (done: number, total: number) => onProgress({ stage, done, total, bytes });

  /**
   * Fetch past the service worker (it would store a second copy). A server that says no, or a picture whose site
   * does not answer in time (the server's proxy waits for it up to 25 s, twice), is left out rather than waited for.
   */
  const fetchFresh = async (url: string, timeoutMs = 30_000): Promise<Response> => {
    if (signal.aborted) throw new Stopped();
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    signal.addEventListener("abort", cancel);
    const timer = window.setTimeout(cancel, timeoutMs);
    try {
      const res = await fetch(url, { headers: { "x-acorn-offline": "1" }, credentials: "same-origin", signal: ctl.signal }).catch((err: Error) => {
        if (signal.aborted) throw new Stopped();
        if (ctl.signal.aborted) throw new Missing(`${url}: no answer in ${timeoutMs / 1000} s`);
        throw new Unreachable(err.message);
      });
      if (res.status === 401) throw new Error("登录已过期，请重新登录后再下载");
      if (!res.ok) throw new Missing(`${url}: HTTP ${res.status}`);
      return res;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  };
  /** Store in a cache under the address the reader will ask for, and count it. */
  const store = async (cache: Cache, url: string, res: Response): Promise<Response> => {
    const copy = res.clone();
    await cache.put(url, res);
    if (cache === offline) keep.add(url);
    bytes += (await copy.clone().blob()).size;
    return copy;
  };
  const json = async <T,>(url: string): Promise<T> => (await store(offline, url, await fetchFresh(url))).json() as Promise<T>;
  /** A picture: kept if this device has it already (from the last pack, or seen recently), fetched otherwise. */
  const picture = async (url: string): Promise<void> => {
    if (keep.has(url)) return;
    const had = (await offline.match(url)) || (await media.match(url));
    if (had) {
      if (!(await offline.match(url))) await offline.put(url, had);
      keep.add(url);
      return;
    }
    if (bytes > room) {
      note = "这台设备的空间不够了，后面的图片没有存";
      return;
    }
    try {
      await store(offline, url, await fetchFresh(url, 20_000));
      images++;
    } catch (err) {
      if (err instanceof Missing) skipped++;
      throw err;
    }
  };

  try {
    // 1. the app: page, code, styles, and the reading font, so the reader opens and looks the same offline
    const assets = await api.offlineAssets();
    const boot = await json<Bootstrap>("/api/bootstrap");
    await json("/api/session");
    const font = boot.settings.reader.font;
    const files = [...assets.app, ...(opts.fonts && (font === "serif" || font === "kai") ? assets.fonts[font] : [])];
    let done = 0;
    await each(files, 6, async (url) => {
      // the page and manifest change with each version; the files under /assets are named by their content
      if (!url.startsWith("/assets/") || !(await shell.match(url))) await store(shell, url, await fetchFresh(url));
      report(++done, files.length);
    });
    // files of older versions are not needed any more (unless this page is one of them), nor are pages kept by
    // address before the app kept one copy of itself (web/public/sw.js)
    const current = new Set([...assets.app, ...assets.fonts.serif, ...assets.fonts.kai]);
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
    if (mine && current.has(pathOf(mine.src))) {
      for (const req of await shell.keys()) if (!current.has(pathOf(req.url))) await shell.delete(req);
    }

    // 2. the lists, page by page as the reader will scroll through them, with the same filters and order
    stage = "lists";
    const how = { unreadOnly: getLocal("acorn.unread.view", "0", ["1", "0"]) === "1", order: getLocal<"new" | "old">("acorn.order.view", "new", ["new", "old"]) };
    const lists: { q: EntryQuery; max: number }[] = [
      { q: listQuery({ view: "starred" }, how), max: 500 },
      { q: listQuery({ view: "progress" }, how), max: 200 },
      { q: { view: "progress" }, max: 40 }, // the 在读 list on the empty reading pane asks for this one
      { q: listQuery({ view: "unread" }, how), max: opts.unread },
      { q: listQuery({ view: "today" }, how), max: 40 },
    ];
    const entries = new Map<number, EntrySummary>();
    for (const [i, { q, max }] of lists.entries()) {
      let cursor: string | null = null;
      let seen = 0;
      do {
        const url = entriesPath(q, cursor);
        const page: Page<EntrySummary> = keep.has(url) ? { items: [], nextCursor: null } : await json<Page<EntrySummary>>(url);
        for (const e of page.items) if (!entries.has(e.id)) entries.set(e.id, e);
        seen += page.items.length;
        cursor = page.nextCursor;
      } while (cursor && seen < max);
      report(i + 1, lists.length);
    }

    // 3. each article and its pictures; an article that is gone by now is left out
    stage = "articles";
    const list = [...entries.values()];
    done = 0;
    await each(list, 4, async (e) => {
      try {
        const entry = await json<Entry>(`/api/entries/${e.id}`);
        if (opts.images) {
          const found = articleImages(new DOMParser().parseFromString(entry.content || "", "text/html"));
          Object.assign(aliases, found.aliases);
          // a few at a time: one slow site should not hold up the rest of the article
          await each(found.urls, 3, picture);
        }
        articles++;
      } finally {
        report(++done, list.length);
      }
    });

    // 4. what the lists show around the articles: thumbnails and the icons of the feeds
    stage = "finishing";
    const extras = [
      ...(opts.images ? list.filter((e) => e.image).map((e) => imageProxy(e.image!, e.url)) : []),
      ...boot.feeds.filter((f) => f.hasIcon).map((f) => `/api/icons/${f.id}`),
    ];
    done = 0;
    await each(extras, 6, async (url) => {
      await picture(url);
      report(++done, extras.length);
    });
    await offline.put(ALIASES, new Response(JSON.stringify(aliases), { headers: { "content-type": "application/json" } }));

    // complete: what the old pack had and this one does not is no longer needed
    for (const req of await offline.keys()) if (!keep.has(pathOf(req.url))) await offline.delete(req);
    return finish({ at: Date.now(), articles, images, skipped, bytes, complete: true, note });
  } catch (err) {
    if (!(err instanceof Stopped) && !(err instanceof Unreachable)) throw err;
    // cancelled, or the connection dropped: what is stored so far stays usable
    await offline.put(ALIASES, new Response(JSON.stringify(aliases), { headers: { "content-type": "application/json" } })).catch(() => undefined);
    const why = err instanceof Stopped ? "下载到一半取消了" : "下载到一半连接断了，已经存下的照样能读";
    return finish({ at: Date.now(), articles, images, skipped, bytes, complete: false, note: why });
  }
}

function finish(info: PackInfo): PackInfo {
  setLocal(INFO, JSON.stringify(info));
  return info;
}
