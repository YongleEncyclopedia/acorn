/**
 * Reading through the user's own browser (ego-browser): for sites whose bot protection stops servers (a JavaScript
 * check a browser passes on its own; captchas are never solved), and for pages whose list is filled in by scripts.
 * One browser read at a time, in a task space of its own that is closed afterwards.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import { egoAvailable, runEgo } from "../archive/browser.ts";

export interface BrowserPage {
  status: number;
  url: string;
  contentType: string;
  text: string;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run one browser job after the others (the user's browser is one machine, not a farm). */
function serially<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

async function needBrowser(app: App): Promise<void> {
  if (!(await egoAvailable(app))) throw new Error("这个来源要用浏览器读取，但运行松果的电脑上没有 ego 浏览器");
}

const stamp = () => new Date().toTimeString().slice(0, 8);

/**
 * raw: the address as it is served (a feed, a JSON API), fetched from inside the site's page so the browser's
 * pass is used; rendered: the page after its scripts ran.
 */
export async function browserRead(app: App, url: string, mode: "raw" | "rendered", timeoutMs = 90_000): Promise<BrowserPage> {
  await needBrowser(app);
  return serially(async () => {
    const out = mkdtempSync(path.join(app.cfg.cacheDir, "read-"));
    const script = `
const fs = await import("node:fs/promises");
const OUT = ${JSON.stringify(out)};
const URL_ = ${JSON.stringify(url)};
const task = await taskSpace(${JSON.stringify(`松果读取 ${stamp()}`)});
let result = { ok: false };
try {
  const page = task.page("p1");
  await page.goto(URL_, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(${mode === "rendered" ? 2500 : 800});
  if (${JSON.stringify(mode)} === "rendered") {
    await fs.writeFile(OUT + "/body", await page.evaluate(() => "<!doctype html>\\n" + document.documentElement.outerHTML));
    result = { ok: true, status: 200, url: await page.url(), contentType: "text/html" };
  } else {
    const r = await page.fetch(URL_, { timeout: 30000 });
    await fs.writeFile(OUT + "/body", r.body || "");
    const h = r.headers || {};
    result = { ok: true, status: r.status, url: r.url || URL_, contentType: h["content-type"] || h["Content-Type"] || "" };
  }
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
} finally {
  try { await task.finish({ keep: [] }); } catch (e) { console.error("finish failed", e && e.message); }
}
console.log("ACORN_RESULT " + JSON.stringify(result));
`;
    try {
      const { res } = await runEgo<{ ok: boolean; status?: number; url?: string; contentType?: string; error?: string }>(app, script, out, timeoutMs);
      if (!res.ok) throw new Error(`浏览器没能打开 ${url}：${res.error}`);
      const file = path.join(out, "body");
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if ((res.status ?? 200) >= 400) throw new Error(`浏览器打开 ${url} 得到 HTTP ${res.status}`);
      return { status: res.status ?? 200, url: res.url || url, contentType: res.contentType || "", text };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

export interface BrowserFinds {
  finalUrl: string;
  title: string;
  /** The page as its scripts left it. */
  html: string;
  /** Addresses on the page that turned out to be feeds, read by the browser. */
  feeds: { url: string; text: string }[];
  /** JSON the page's scripts loaded (with GET), read by the browser. */
  json: { url: string; text: string }[];
}

/**
 * Look at a page the way the user's browser sees it: its feeds (declared, or linked as RSS), the JSON its scripts
 * load, and the page itself once rendered. Everything is read inside the browser, past any bot check.
 */
export async function browserDiscover(app: App, url: string, timeoutMs = 120_000): Promise<BrowserFinds> {
  await needBrowser(app);
  return serially(async () => {
    const out = mkdtempSync(path.join(app.cfg.cacheDir, "discover-"));
    const script = `
const fs = await import("node:fs/promises");
const OUT = ${JSON.stringify(out)};
const URL_ = ${JSON.stringify(url)};
const task = await taskSpace(${JSON.stringify(`松果识别 ${stamp()}`)});
let result = { ok: false };
try {
  const page = task.page("p1");
  await page.goto(URL_, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // a little scrolling brings in lists that load as they come into view
  await page.evaluate(() => window.scrollBy(0, Math.max(800, window.innerHeight)));
  await page.waitForTimeout(1500);
  const finalUrl = await page.url();
  const found = await page.evaluate(() => {
    const abs = (h) => { try { return new URL(h, location.href).href; } catch { return null; } };
    const feeds = [...document.querySelectorAll('link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"], link[rel~="alternate"][type*="feed"], link[rel="feed"]')].map((l) => abs(l.getAttribute("href")));
    const anchors = [...document.querySelectorAll("a[href]")].filter((a) => /(^|[\\/._?=-])(rss|feeds?|atom)([\\/._?=-]|$)/i.test(a.getAttribute("href") || "") || /^\\s*(rss|atom|feeds?|rss ?订阅|订阅源)\\s*$/i.test(a.textContent || "")).map((a) => abs(a.getAttribute("href")));
    const calls = performance.getEntriesByType("resource").filter((r) => r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest").map((r) => r.name);
    return { title: document.title, feeds, anchors, calls, html: "<!doctype html>\\n" + document.documentElement.outerHTML };
  });
  await fs.writeFile(OUT + "/page.html", found.html);
  const uniq = (list) => [...new Set(list.filter((u) => u && /^https?:/i.test(u)))];
  const feedLike = (t) => /^\\s*(<\\?xml[^>]*>\\s*)?(<\\?xml-stylesheet[^>]*>\\s*)*(<!--[\\s\\S]*?-->\\s*)*<(rss|feed|rdf:RDF)\\b/i.test(t) || /"version"\\s*:\\s*"https:\\/\\/jsonfeed\\.org/i.test(t.slice(0, 400));
  const feeds = [];
  for (const u of uniq([...found.feeds, ...found.anchors]).slice(0, 10)) {
    try {
      const r = await page.fetch(u, { timeout: 15000 });
      if (r.ok && feedLike(r.body || "")) { feeds.push(u); await fs.writeFile(OUT + "/feed-" + feeds.length, r.body); }
    } catch (e) { /* not reachable: not offered */ }
  }
  const json = [];
  const skip = /google-analytics|googletagmanager|doubleclick|hm\\.baidu|cnzz|umeng|sentry|clarity|hotjar|bat\\.bing|\\.(png|jpe?g|gif|webp|svg|css|js|woff2?)(\\?|$)/i;
  for (const u of uniq(found.calls).filter((u) => !skip.test(u)).slice(0, 24)) {
    try {
      const r = await page.fetch(u, { timeout: 12000 });
      const body = r.body || "";
      if (r.ok && /^\\s*[\\[{]/.test(body) && body.length > 200 && body.length < 3000000) { json.push(u); await fs.writeFile(OUT + "/json-" + json.length, body); }
    } catch (e) { /* skip */ }
    if (json.length >= 12) break;
  }
  result = { ok: true, finalUrl, title: found.title, feeds, json };
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
} finally {
  try { await task.finish({ keep: [] }); } catch (e) { console.error("finish failed", e && e.message); }
}
console.log("ACORN_RESULT " + JSON.stringify(result));
`;
    try {
      const { res, read } = await runEgo<{ ok: boolean; finalUrl?: string; title?: string; feeds?: string[]; json?: string[]; error?: string }>(app, script, out, timeoutMs);
      if (!res.ok) throw new Error(`浏览器没能打开 ${url}：${res.error}`);
      const text = (f: string) => read(f)?.toString("utf8") ?? "";
      return {
        finalUrl: res.finalUrl || url,
        title: res.title || "",
        html: text("page.html"),
        feeds: (res.feeds || []).map((u, i) => ({ url: u, text: text(`feed-${i + 1}`) })),
        json: (res.json || []).map((u, i) => ({ url: u, text: text(`json-${i + 1}`) })),
      };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
