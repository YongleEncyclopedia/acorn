/**
 * WeChat accounts through we-mp-rss: a fake we-mp-rss on localhost serves the account list and per-account feeds
 * in the shape the real one produces. Nothing may touch mp.weixin.qq.com: the feed already carries the text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { syncWechatBridge } from "../src/server/feeds/wechat-bridge.ts";
import { refreshFeed } from "../src/server/feeds/refresh.ts";
import { iconFile } from "../src/server/feeds/icons.ts";

process.env.ACORN_SILENT = "1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(120, 7)]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BODY = (base: string, n: number) =>
  `<section><p>${"松鼠把橡果埋进土里，冬天再慢慢挖出来吃。".repeat(n)}</p><p><img data-src="${base}/img/1.png" data-type="png"></p></section>`;

let site: http.Server;
let base = "";
let app: App;
let web: ReturnType<typeof createHttp>;
let token = "";
let dataDir = "";
let secondBody = "";
const SECOND_TITLE = "第一期：松鼠为什么总是记不住自己把橡果埋在了哪里";
const wechatHits: string[] = [];

// we-mp-rss writes XML with ElementTree: escaped HTML inside content:encoded, guid = article link.
const accountFeed = (id: string, name: string, items: { slug: string; title: string; body: string }[]) =>
  `<?xml version="1.0" encoding="utf-8"?>\r\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${name}</title><link>${base}/feed/${id}.xml</link><description>${name}的简介</description><language>zh-CN</language><generator>Mp-We-Rss</generator><image><url>${base}/avatar/${id}.png</url><title>${name}</title><link>${base}/feed/${id}.xml</link></image>${items
    .map(
      (it) =>
        `<item><id>${id}-${it.slug}</id><title>${it.title}</title><description>${it.body ? `${it.title}的摘要` : it.title}</description><guid>https://mp.weixin.qq.com/s/${it.slug}</guid><enclosure url="${base}/img/1.png" length="0" type="image/jpeg"></enclosure><content:encoded>${esc(it.body)}</content:encoded><link>https://mp.weixin.qq.com/s/${it.slug}</link><pubDate>Wed, 14 Oct 2026 08:00:00 +0800</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

beforeAll(async () => {
  site = http.createServer((req, res) => {
    const url = req.url || "/";
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (url.startsWith("/rss/fresh")) {
      const offset = Number(new URL(url, base).searchParams.get("offset") || 0);
      const items = offset
        ? ""
        : ["MP_WXS_1:思想花火", "MP_WXS_2:松鼠周刊"]
            .map((s) => s.split(":"))
            .map(([id, name]) => `<item><id>${id}</id><title>${name}</title><description>简介</description><guid>${base}/rss/${id}</guid><enclosure url="${base}/avatar/${id}.png" length="0" type="image/jpeg"></enclosure><link>${base}/rss/${id}</link><pubDate>Wed, 14 Oct 2026 08:00:00 +0800</pubDate></item>`)
            .join("");
      return send(200, "application/xml", `<?xml version="1.0" encoding="utf-8"?>\r\n<rss version="2.0"><channel><title>WeRSS订阅</title><link>${base}/</link><description>RSS频道</description>${items}</channel></rss>`);
    }
    if (url === "/feed/MP_WXS_1.xml") return send(200, "application/xml", accountFeed("MP_WXS_1", "思想花火", [{ slug: "aaa", title: "育儿经", body: BODY(base, 30) }]));
    if (url === "/feed/MP_WXS_2.xml") return send(200, "application/xml", accountFeed("MP_WXS_2", "松鼠周刊", [{ slug: "b~b", title: SECOND_TITLE, body: secondBody }]));
    if (url.startsWith("/avatar/")) return send(200, "image/png", PNG);
    if (url === "/img/1.png") return send(200, "image/png", PNG);
    if (url === "/favicon.ico") return send(200, "image/x-icon", ICO);
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-wechat-"));
  app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
  token = ensureCliToken(app);
  web = createHttp(app);
  // Any request to WeChat itself would be a bug: record instead of going to the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (/weixin\.qq\.com/.test(u)) {
      wechatHits.push(u);
      throw new Error("blocked in test");
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  site.close();
  app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const entryAt = (url: string) => {
  const e = app.entries.byUrl(url);
  return e ? app.entries.row(e.id) : undefined;
};
const api = async <T = Record<string, any>>(p: string, init: RequestInit = {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
  (await (await web.request(p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })).json()) as T;

describe("we-mp-rss bridge", () => {
  it("needs an address before it can sync", async () => {
    await expect(syncWechatBridge(app)).rejects.toThrow(/we-mp-rss/);
  });

  it("subscribes to every account into the 公众号 folder, once", async () => {
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ wechatBridge: { url: `${base}/`, folder: "公众号", autoArchive: true } }) });
    expect(app.settings.all().wechatBridge.url).toBe(base);

    const first = await api("/api/wechat-bridge/sync", { method: "POST" });
    expect(first.total).toBe(2);
    expect(first.added.map((a: { title: string }) => a.title).sort()).toEqual(["思想花火", "松鼠周刊"]);
    const second = await syncWechatBridge(app);
    expect(second.added).toEqual([]);

    const folder = app.feeds.folderByName("公众号");
    const feeds = app.feeds.list().filter((f) => f.url.startsWith(base));
    expect(feeds).toHaveLength(2);
    expect(feeds.every((f) => f.folderId === folder?.id && f.autoArchive)).toBe(true);

    const status = await api("/api/wechat-bridge");
    expect(status.accounts.every((a: { feedId: number | null }) => a.feedId)).toBe(true);
  });

  it("archives the feed's full text and images without fetching WeChat", async () => {
    await app.jobs.idle();
    const entry = entryAt("https://mp.weixin.qq.com/s/aaa");
    expect(entry?.content).toContain(`${base}/img/1.png`);
    expect(entry?.archive_id).toBeTruthy();
    const archive = await api(`/api/archives/${entry!.archive_id}`);
    const snap = archive.snapshots[0];
    expect(snap.method).toBe("feed");
    expect(snap.warnings.join("")).not.toMatch(/失败|无法/);
    expect(snap.assets).toBeGreaterThanOrEqual(1);
    expect(archive.content).toMatch(/<img [^>]*src="\/files\/archive\/[^"]+\.png"/);
    expect(archive.content).not.toContain(` src="${base}`);
    expect(wechatHits.filter((u) => u.includes("/s/aaa"))).toEqual([]);
  });

  it("uses the account avatar as the feed icon, not we-mp-rss's favicon", async () => {
    const feed = app.feeds.list().find((f) => f.title === "思想花火")!;
    const file = iconFile(app, feed.id);
    expect(file && path.extname(file)).toBe(".png");
    expect(readFileSync(file!).equals(PNG)).toBe(true);
  });

  it("repairs we-mp-rss links and tries the page once while the feed has no body", () => {
    const entry = entryAt("https://mp.weixin.qq.com/s/b_b");
    expect(entry?.title).toBe(SECOND_TITLE);
    expect(wechatHits.some((u) => u.includes("/s/b_b"))).toBe(true);
    expect(wechatHits.some((u) => u.includes("~"))).toBe(false);
    // the page was unreachable and the feed only repeats the title: that is not worth an archive
    expect(entry?.archive_id).toBeFalsy();
  });

  it("archives an article once its body arrives later, from the feed", async () => {
    const feed = app.feeds.list().find((f) => f.title === "松鼠周刊")!;
    const hits = wechatHits.length;
    secondBody = BODY(base, 30);
    await refreshFeed(app, feed.id);
    await app.jobs.idle();
    expect(entryAt("https://mp.weixin.qq.com/s/b_b")?.archive_id).toBeTruthy();
    expect(wechatHits.length).toBe(hits);
  });
});
