/**
 * The offline pack (离线包): the pictures it stores for an article, the changes it keeps while offline, the app
 * files it is offered, and that the addresses it stores are the ones the reader asks for. The service worker
 * itself is checked in a browser (web/public/sw.js).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHTML } from "linkedom";
import { addChange, articleImages, dropFields, srcsetUrls, withChanges } from "../src/shared/offline.ts";
import { proxifyHtml, proxyUrl } from "../src/server/api/content.ts";
import { offlineAssets } from "../src/server/api/routes/offline.ts";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { entriesPath, imageProxy, listQuery } from "../web/src/lib/api.ts";

process.env.ACORN_SILENT = "1";

const doc = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

describe("the pictures of an article", () => {
  it("stores each picture once, and lets it stand in for its other sizes", () => {
    const html = proxifyHtml(
      `<p><img src="https://cdn.example/a.jpg" srcset="https://cdn.example/a-400.jpg 400w, https://cdn.example/a-800.jpg 800w"></p>
       <picture><source srcset="https://cdn.example/b.webp 1x, https://cdn.example/b@2x.webp 2x"><img src="https://cdn.example/b.jpg"></picture>
       <img srcset="https://cdn.example/c-1.jpg 1x, https://cdn.example/c-2.jpg 2x">
       <img src="https://cdn.example/a.jpg"><img src="data:image/gif;base64,R0lGOD">
       <video poster="https://cdn.example/v.jpg"></video>`,
      "https://blog.example/post",
    );
    const p = (u: string) => proxyUrl(u, "https://blog.example/post");
    const found = articleImages(doc(html));
    expect(found.urls).toEqual([p("https://cdn.example/a.jpg"), p("https://cdn.example/b.jpg"), p("https://cdn.example/c-2.jpg"), p("https://cdn.example/v.jpg")]);
    expect(found.aliases).toEqual({
      [p("https://cdn.example/a-400.jpg")]: p("https://cdn.example/a.jpg"),
      [p("https://cdn.example/a-800.jpg")]: p("https://cdn.example/a.jpg"),
      [p("https://cdn.example/b.webp")]: p("https://cdn.example/b.jpg"),
      [p("https://cdn.example/b@2x.webp")]: p("https://cdn.example/b.jpg"),
      [p("https://cdn.example/c-1.jpg")]: p("https://cdn.example/c-2.jpg"),
    });
  });

  it("reads srcset the way the server writes it", () => {
    expect(srcsetUrls("/api/img?u=a%2Cb 1x, /api/img?u=c 2x")).toEqual(["/api/img?u=a%2Cb", "/api/img?u=c"]);
    expect(srcsetUrls(undefined)).toEqual([]);
  });

  it("asks for list pages and pictures at the addresses the server and the lists use", () => {
    // a thumbnail in a list and a picture in an article go through the same proxy address
    expect(imageProxy("https://cdn.example/a b.jpg?x=1&y=2", "https://blog.example/p?id=3")).toBe(proxyUrl("https://cdn.example/a b.jpg?x=1&y=2", "https://blog.example/p?id=3"));
    expect(imageProxy("https://cdn.example/a.jpg", null)).toBe(proxyUrl("https://cdn.example/a.jpg"));
    // 未读 cannot hide what is read; 今日 can
    expect(entriesPath(listQuery({ view: "unread" }, { unreadOnly: true, order: "new" }))).toBe("/api/entries?view=unread&limit=40");
    expect(entriesPath(listQuery({ view: "today" }, { unreadOnly: true, order: "old" }), "c1")).toBe("/api/entries?view=today&unread=true&order=old&cursor=c1&limit=40");
    expect(entriesPath(listQuery({ view: "progress" }, { unreadOnly: false, order: "new" }))).toBe(entriesPath({ view: "progress" }));
  });
});

describe("changes made offline", () => {
  const entry = { id: 7, readAt: null as number | null, starredAt: 1000 as number | null, progress: 0 };

  it("merges changes to the same article, the latest winning field by field", () => {
    let box = addChange({}, 7, { read: true }, 10);
    box = addChange(box, 7, { progress: 0.4, starred: undefined }, 20);
    box = addChange(box, 8, { starred: true }, 30);
    expect(box).toEqual({ 7: { read: true, progress: 0.4, at: 20 }, 8: { starred: true, at: 30 } });
    // what the server was just given anew is no longer waiting
    expect(dropFields(box, 7, ["read"])).toEqual({ 7: { progress: 0.4, at: 20 }, 8: { starred: true, at: 30 } });
    expect(dropFields(box, 8, ["starred"])).toEqual({ 7: { read: true, progress: 0.4, at: 20 } });
  });

  it("shows waiting changes on the stored copy of an article", () => {
    const box = addChange(addChange({}, 7, { read: true, starred: false }, 50), 7, { progress: 0.5 }, 60);
    expect(withChanges(entry, box)).toEqual({ id: 7, readAt: 60, starredAt: null, progress: 0.5 });
    expect(withChanges({ ...entry, id: 9 }, box)).toEqual({ ...entry, id: 9 });
  });
});

describe("the app files a device stores", () => {
  let web = "";
  let data = "";
  let app: App;

  beforeAll(() => {
    web = mkdtempSync(path.join(os.tmpdir(), "acorn-web-"));
    data = mkdtempSync(path.join(os.tmpdir(), "acorn-offline-"));
    mkdirSync(path.join(web, "assets"));
    const put = (f: string, size: number) => writeFileSync(path.join(web, f), "x".repeat(size));
    put("index.html", 100);
    put("manifest.webmanifest", 10);
    put("icon.svg", 5);
    put("assets/index-abc.js", 1000);
    put("assets/fonts-def.css", 200);
    put("assets/noto-serif-sc-99-400-normal-x1.woff2", 3000);
    put("assets/literata-latin-wght-normal-x2.woff2", 400);
    put("assets/lxgwwenkaiscreen-subset-4-x3.woff2", 2000);
    app = createApp(loadConfig({ ACORN_DATA_DIR: data, ACORN_WEB_DIR: web, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
  });

  afterAll(() => {
    app.db.close();
    rmSync(web, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("offers the app, and each reading font apart", () => {
    expect(offlineAssets(web)).toEqual({
      app: ["/", "/manifest.webmanifest", "/icon.svg", "/assets/fonts-def.css", "/assets/index-abc.js"],
      fonts: { serif: ["/assets/literata-latin-wght-normal-x2.woff2", "/assets/noto-serif-sc-99-400-normal-x1.woff2"], kai: ["/assets/lxgwwenkaiscreen-subset-4-x3.woff2"] },
      bytes: { app: 1315, serif: 3400, kai: 2000 },
    });
  });

  it("lists them for signed-in devices only", async () => {
    const http = createHttp(app);
    expect((await http.request("/api/offline/assets")).status).toBe(401);
    const res = await http.request("/api/offline/assets", { headers: { authorization: `Bearer ${ensureCliToken(app)}` } });
    expect((await res.json()).fonts.kai).toEqual(["/assets/lxgwwenkaiscreen-subset-4-x3.woff2"]);
  });
});
