/**
 * End-to-end tests against a fixture website served on localhost: subscribe → full text → read later → archive
 * (images + attachments) → highlight → search → Google Reader API → RSS output → source disappears.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { COUNTS_SQL, createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { listSql } from "../src/server/store/entries.ts";
import { createHttp } from "../src/server/api/http.ts";
import { setPassword } from "../src/server/api/auth.ts";

process.env.ACORN_SILENT = "1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ARTICLE = (base: string) => `<!doctype html><html><head><meta charset="utf-8"><title>松果测试文章 - 测试站</title>
<meta property="og:site_name" content="测试站"></head><body><nav><a href="/">首页</a></nav>
<article><h1>松果测试文章</h1>
${Array.from({ length: 8 }, (_, i) => `<p>这是第 ${i + 1} 段正文。松鼠在秋天把橡果埋进土里，留到冬天慢慢吃，这段话用来测试正文提取与全文检索是否正常工作。</p>`).join("\n")}
<p><img src="/img/a.png" alt="配图"></p>
<p>附件：<a href="${base}/files/report.pdf">年度报告.pdf</a></p>
</article><footer>版权所有</footer></body></html>`;

let site: http.Server;
let base = "";
let postGone = false;
let app: App;
let web: ReturnType<typeof createHttp>;
let token = "";
let dataDir = "";

beforeAll(async () => {
  site = http.createServer((req, res) => {
    const url = req.url || "/";
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (url === "/feed.xml") {
      return send(
        200,
        "application/rss+xml; charset=utf-8",
        `<?xml version="1.0"?><rss version="2.0"><channel><title>测试站</title><link>${base}/</link>
        <item><title>松果测试文章</title><link>${base}/post/1</link><guid>post-1</guid><pubDate>Tue, 13 Oct 2026 06:00:00 +0000</pubDate><description>一句话摘要。查看全文</description></item>
        <item><title>第二篇</title><link>${base}/post/2</link><guid>post-2</guid><pubDate>Mon, 12 Oct 2026 06:00:00 +0000</pubDate><description><![CDATA[${"<p>完整内容。</p>".repeat(80)}]]></description></item>
        </channel></rss>`,
      );
    }
    if (url === "/page-with-feed") return send(200, "text/html", `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>`);
    if (url.startsWith("/post/1")) return postGone ? send(404, "text/html", "not found") : send(200, "text/html; charset=utf-8", ARTICLE(base));
    if (url.startsWith("/post/2")) return send(200, "text/html; charset=utf-8", ARTICLE(base).replace("松果测试文章", "第二篇"));
    if (url === "/img/a.png") return send(200, "image/png", PNG);
    if (url === "/files/report.pdf") return send(200, "application/pdf", Buffer.from("%PDF-1.4\n% acorn test attachment\n" + "x".repeat(200)));
    if (url === "/notices") {
      const rows = Array.from({ length: 6 }, (_, i) => `<li><a href="/notice/${i}" title="关于第${i + 1}次测试的通知全文标题">关于第${i + 1}次测试的通知…</a><span class="date">2026-10-0${i + 1}</span></li>`).join("");
      return send(200, "text/html; charset=utf-8", `<html><head><title>通知公告</title></head><body><ul class="nav"><li><a href="/">首页</a></li></ul><div class="list"><ul>${rows}</ul></div></body></html>`);
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-test-"));
  app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
  setPassword(app, "secret123");
  token = ensureCliToken(app);
  web = createHttp(app);
});

afterAll(() => {
  site.close();
  app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const req = (p: string, init: RequestInit = {}) =>
  web.request(p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
const json = async <T = Record<string, any>>(p: string, init?: RequestInit) => (await (await req(p, init)).json()) as T; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("auth", () => {
  it("rejects anonymous API calls and accepts password login", async () => {
    expect((await web.request("/api/counts")).status).toBe(401);
    expect((await web.request("/api/login", { method: "POST", body: JSON.stringify({ password: "wrong" }), headers: { "content-type": "application/json" } })).status).toBe(403);
    const ok = await web.request("/api/login", { method: "POST", body: JSON.stringify({ password: "secret123" }), headers: { "content-type": "application/json" } });
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    const s = await (await web.request("/api/session", { headers: { cookie } })).json();
    expect(s.authenticated).toBe(true);
  });
});

describe("reading and archiving", () => {
  let entryId = 0;
  let archiveId = 0;

  it("subscribes through feed discovery and fetches full text for teaser items", async () => {
    const r = await req("/api/feeds", { method: "POST", body: JSON.stringify({ input: `${base}/page-with-feed`, folderName: "测试" }) });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.feed.url).toBe(`${base}/feed.xml`);
    expect(body.added).toBe(2);
    await app.jobs.idle();
    const list = await json("/api/entries?view=unread");
    expect(list.items.map((e: { title: string }) => e.title)).toEqual(["松果测试文章", "第二篇"]);
    entryId = list.items[0].id;
    const e = await json(`/api/entries/${entryId}`);
    expect(e.hasFullContent).toBe(true);
    expect(e.content).toContain("第 8 段正文");
    expect(e.content).toContain("/api/img?u=");
  });

  it("archives on read-later with images and attachments on disk", async () => {
    await req(`/api/entries/${entryId}`, { method: "PATCH", body: JSON.stringify({ starred: true }) });
    await app.jobs.idle();
    const page = await json("/api/archives");
    expect(page.items).toHaveLength(1);
    archiveId = page.items[0].id;
    const a = await json(`/api/archives/${archiveId}`);
    expect(a.site).toBe("测试站");
    expect(a.content).toMatch(/\/files\/archive\/.+\/assets\/[0-9a-f]{16}\.png/);
    expect(a.content).toMatch(/\/files\/archive\/.+\/attachments\//);
    const snapDir = path.join(app.cfg.archiveDir, a.snapshots[0].files.folder);
    expect(readdirSync(snapDir).sort()).toEqual(expect.arrayContaining(["article.html", "article.md", "assets", "attachments", "content.html", "meta.json", "source.html"]));
    expect(readdirSync(path.join(snapDir, "attachments"))).toEqual(["年度报告.pdf"]);
    const file = await req(a.snapshots[0].files.article);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("re-capturing unchanged content does not create a new version", async () => {
    const r = await json("/api/archives", { method: "POST", body: JSON.stringify({ entryId, wait: true }) });
    expect(r.unchanged).toBe(true);
  });

  it("stores highlights and finds everything through search", async () => {
    const h = await req("/api/highlights", { method: "POST", body: JSON.stringify({ entryId, quote: "松鼠在秋天把橡果埋进土里", prefix: "", suffix: "", note: "好比喻" }) });
    expect(h.status).toBe(201);
    const a = await json(`/api/archives/${archiveId}`);
    expect(a.highlights[0].note).toBe("好比喻");
    const s = await json(`/api/search?q=${encodeURIComponent("橡果埋进")}`);
    expect(s.entries.length).toBeGreaterThan(0);
    expect(s.archives.length).toBe(1);
    expect(s.highlights.length).toBe(1);
  });

  it("detects when the original disappears", async () => {
    postGone = true;
    const r = await json(`/api/archives/${archiveId}/recheck`, { method: "POST" });
    expect(r.status).toBe("gone");
    const counts = await json("/api/counts");
    expect(counts.gone).toBe(1);
    const a = await json(`/api/archives/${archiveId}`);
    expect(a.content).toContain("第 8 段正文");
  });
});

describe("web page sources", () => {
  it("turns a notice list page into a source with dates", async () => {
    const p = await json("/api/feeds/preview", { method: "POST", body: JSON.stringify({ input: `${base}/notices` }) });
    expect(p.kind).toBe("html");
    expect(p.suggestedRule.item).toContain("li");
    expect(p.items).toHaveLength(6);
    expect(p.items[0].title).toBe("关于第1次测试的通知全文标题");
    expect(new Date(p.items[0].publishedAt).getDate()).toBe(1);
  });
});

describe("Google Reader API", () => {
  it("logs in, lists, reads and marks", async () => {
    const login = await web.request("/accounts/ClientLogin", { method: "POST", body: new URLSearchParams({ Email: "me", Passwd: "secret123" }) });
    const auth = (await login.text()).match(/Auth=(.+)/)![1];
    const g = (p: string, init: RequestInit = {}) => web.request(p, { ...init, headers: { authorization: `GoogleLogin auth=${auth}`, ...(init.headers || {}) } });
    const subs = await (await g("/reader/api/0/subscription/list?output=json")).json();
    expect(subs.subscriptions[0].categories[0].label).toBe("测试");
    const ids = await (await g("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&xt=user/-/state/com.google/read&n=50")).json();
    expect(ids.itemRefs.length).toBeGreaterThanOrEqual(1);
    const id = ids.itemRefs[0].id;
    const contents = await (await g("/reader/api/0/stream/items/contents", { method: "POST", body: new URLSearchParams({ i: id }) })).json();
    expect(contents.items[0].id).toMatch(/^tag:google\.com,2005:reader\/item\/[0-9a-f]{16}$/);
    expect(await (await g("/reader/api/0/edit-tag", { method: "POST", body: new URLSearchParams({ i: contents.items[0].id, a: "user/-/state/com.google/read" }) })).text()).toBe("OK");
    const after = await (await g("/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&xt=user/-/state/com.google/read&n=50")).json();
    expect(after.itemRefs.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });
});

describe("outputs and safety", () => {
  it("re-publishes a feed as RSS with a key", async () => {
    expect((await web.request("/out/feed/1.xml")).status).toBe(401);
    const r = await web.request(`/out/feed/1.xml?key=${token}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<content:encoded><![CDATA[");
  });
  it("blocks path traversal and non-image proxying", async () => {
    expect((await req("/files/archive/..%2F..%2Facorn.db")).status).toBe(404);
    expect((await req(`/api/img?u=${encodeURIComponent(`${base}/post/2`)}`)).status).toBe(502);
    expect((await req(`/api/img?u=${encodeURIComponent("file:///etc/passwd")}`)).status).toBe(400);
  });
  it("exports OPML", async () => {
    const xml = await (await req("/api/opml")).text();
    expect(xml).toContain(`${base}/feed.xml`);
    expect(xml).toContain('<outline text="测试"');
  });
  it("keeps the data folder self-contained", () => {
    expect(existsSync(path.join(dataDir, "acorn.db"))).toBe(true);
    expect(existsSync(path.join(dataDir, ".cli-token"))).toBe(true);
  });
});

describe("signing in another device", () => {
  it("logs a phone in once with a QR link, then refuses the same link", async () => {
    const link = await json("/api/login-link", { method: "POST" });
    expect(link.path).toMatch(/^\/login\/[\w-]{20,}$/);
    expect(Array.isArray(link.origins)).toBe(true); // which addresses depends on the machine

    const first = await web.request(link.path);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/");
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toMatch(/^acorn_session=/);
    const session = await (await web.request("/api/session", { headers: { cookie } })).json();
    expect(session.authenticated).toBe(true);

    const again = await web.request(link.path);
    expect(again.headers.get("location")).toBe("/?login=expired");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("does not hand out links to anyone who is not signed in", async () => {
    expect((await web.request("/api/login-link", { method: "POST" })).status).toBe(401);
  });
});

describe("serving a phone on a slow link", () => {
  it("gzips JSON for clients that ask, and only for them", async () => {
    const plain = await req("/api/bootstrap");
    expect(plain.headers.get("content-encoding")).toBeNull();

    const zipped = await req("/api/bootstrap", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toMatch(/accept-encoding/i);
    const text = await new Response(zipped.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text).feeds.length).toBeGreaterThan(0);
  });

  it("leaves images and ZIP exports as they are", async () => {
    const zip = await req("/api/export", { headers: { "accept-encoding": "gzip" } });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-encoding")).toBeNull();
    await zip.arrayBuffer();
    const img = await req(`/api/img?u=${encodeURIComponent(`${base}/img/a.png`)}`, { headers: { "accept-encoding": "gzip" } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-encoding")).toBeNull();
  });
});

describe("marking a stretch of a list as read", () => {
  const mark = async (body: object) => (await json("/api/entries/mark", { method: "POST", body: JSON.stringify(body) })).changed;
  const unreadIds = async (feed: number) => (await json(`/api/entries?view=unread&feed=${feed}`)).items.map((e: { id: number }) => e.id);

  it("marks what is newer than an entry, or that entry and everything older", async () => {
    const all = await json("/api/entries?view=all&feed=1");
    const [newer, older] = all.items as { id: number; publishedAt: number }[];
    expect(newer.publishedAt).toBeGreaterThan(older.publishedAt);
    const unread = () => req("/api/entries/mark", { method: "POST", body: JSON.stringify({ ids: [newer.id, older.id], read: false }) });

    await unread();
    expect(await mark({ feedId: 1, newerThan: older.id })).toBe(1);
    expect(await unreadIds(1)).toEqual([older.id]);

    await unread();
    expect(await mark({ feedId: 1, upTo: older.id })).toBe(1);
    expect(await unreadIds(1)).toEqual([newer.id]);

    await unread();
    expect(await mark({ feedId: 1, upTo: newer.id })).toBe(2);
    expect(await mark({ feedId: 1, upTo: 987654 })).toBe(0); // an entry that does not exist marks nothing
  });

  it("splits entries published at the same instant the way the list orders them", async () => {
    // A notice page with dates only: every item of a day has the same time, and the list falls back to the id.
    const feed = app.feeds.create({ kind: "feed", url: `${base}/same-day.xml`, title: "同一天" });
    const day = Date.UTC(2026, 9, 9);
    const item = (n: number) => ({ guid: `same-${n}`, url: null, title: `通知 ${n}`, author: null, content: null, summary: null, image: null, publishedAt: day, wordCount: 0 });
    app.entries.upsert(feed.id, [item(3), item(2), item(1)]);
    const listed = (await json(`/api/entries?view=all&feed=${feed.id}`)).items.map((e: { id: number }) => e.id) as number[];
    const [top, middle, bottom] = listed;

    expect(await mark({ feedId: feed.id, newerThan: middle })).toBe(1);
    expect(await unreadIds(feed.id)).toEqual([middle, bottom]);

    await req("/api/entries/mark", { method: "POST", body: JSON.stringify({ ids: listed, read: false }) });
    expect(await mark({ feedId: feed.id, upTo: middle })).toBe(2);
    expect(await unreadIds(feed.id)).toEqual([top]);
    app.feeds.delete(feed.id);
  });
});

describe("large libraries", () => {
  // Partial indexes are only used while the queries repeat their conditions literally; this catches the day
  // someone changes one side and the lists quietly go back to scanning every entry.
  const plan = (sql: string, ...params: (string | number)[]) =>
    app.db
      .all<{ detail: string }>(`explain query plan ${sql}`, ...params)
      .map((r) => r.detail)
      .join("\n");

  it("lists unread and in-progress entries through their own indexes", () => {
    const unread = listSql({ view: "unread" });
    expect(plan(unread.sql, ...(unread.params as number[]), 41)).toContain("entries_unread_time");
    const reading = listSql({ view: "progress" });
    expect(plan(reading.sql, ...(reading.params as number[]), 41)).toContain("entries_in_progress");
  });

  it("counts for the sidebar without scanning the entries table", () => {
    const p = plan(COUNTS_SQL, 0);
    expect(p).toContain("entries_in_progress");
    expect(p).not.toMatch(/SCAN entries(?! USING)/);
  });
});
