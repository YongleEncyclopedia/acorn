/**
 * Any source as a subscription: feeds a page only links to, site patterns, RSSHub's radar rules, JSON interfaces,
 * watched pages, push addresses, bot checks, the RSS addresses and the proxy settings — against a stand-in site.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseHTML } from "linkedom";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { refreshFeed } from "../src/server/feeds/refresh.ts";
import { matchRadar, type RadarRules } from "../src/server/feeds/radar.ts";
import { siteFeeds } from "../src/server/feeds/hints.ts";
import { suggestJsonRule, jsonItems, fill } from "../src/server/feeds/builtin/json.ts";
import { diffLines, pageLines } from "../src/server/feeds/builtin/watch.ts";
import { pushedItems } from "../src/server/feeds/builtin/inbox.ts";
import { describeNetworkError, effectiveProxy } from "../src/server/util/proxy.ts";
import { parseLooseDate } from "../src/server/util/dates.ts";

process.env.ACORN_SILENT = "1";

const RULES: RadarRules = {
  "bilibili.com": { _name: "哔哩哔哩", space: [{ title: "UP 主动态", source: ["/:uid"], target: "/bilibili/user/dynamic/:uid" }] },
  "t.me": { _name: "Telegram", ".": [{ title: "Channel", source: ["/s/:username"], target: "/telegram/channel/:username" }] },
  "nikkei.com": { _name: "日经", cn: [{ title: "中文版新闻", source: ["/:category/:type", "/:category", "/"], target: "/nikkei/cn/cn/:category?/:type?" }] },
  "example.com": { _name: "例子", ".": [{ title: "需要参数", source: ["/"], target: "/example/:id" }, { title: "热榜", source: ["/hot?type=:t"], target: "/example/hot/:t" }] },
};

describe("finding a way to subscribe", () => {
  it("turns platform pages into RSSHub routes", () => {
    expect(matchRadar(RULES, "https://space.bilibili.com/2267573")).toEqual([{ title: "UP 主动态", route: "/bilibili/user/dynamic/2267573" }]);
    expect(matchRadar(RULES, "https://t.me/durov").map((m) => m.route)).toEqual(["/telegram/channel/durov"]);
    expect(matchRadar(RULES, "https://cn.nikkei.com/").map((m) => m.route)).toEqual(["/nikkei/cn/cn"]);
    expect(matchRadar(RULES, "https://cn.nikkei.com/politicsaeconomy/").map((m) => m.route)).toEqual(["/nikkei/cn/cn/politicsaeconomy"]);
    // a route that needs what the page does not give is not offered; query parameters are read
    expect(matchRadar(RULES, "https://example.com/").map((m) => m.route)).toEqual([]);
    expect(matchRadar(RULES, "https://www.example.com/hot?type=day").map((m) => m.route)).toEqual(["/example/hot/day"]);
    expect(matchRadar(RULES, "https://unknown.example.org/x")).toEqual([]);
  });

  it("knows feeds sites have but do not announce", () => {
    expect(siteFeeds("https://github.com/DIYgod/RSSHub").map((h) => h.url)).toEqual(["https://github.com/DIYgod/RSSHub/releases.atom", "https://github.com/DIYgod/RSSHub/commits.atom", "https://github.com/DIYgod/RSSHub/tags.atom"]);
    expect(siteFeeds("https://github.com/torvalds").map((h) => h.url)).toEqual(["https://github.com/torvalds.atom"]);
    expect(siteFeeds("https://github.com/settings").map((h) => h.url)).toEqual([]);
    expect(siteFeeds("https://www.reddit.com/r/rss/").map((h) => h.url)).toEqual(["https://www.reddit.com/r/rss/.rss"]);
    expect(siteFeeds("https://bsky.app/profile/jay.bsky.team").map((h) => h.url)).toEqual(["https://bsky.app/profile/jay.bsky.team/rss"]);
    expect(siteFeeds("https://mastodon.social/@Gargron").map((h) => h.url)).toEqual(["https://mastodon.social/@Gargron.rss"]);
  });

  it("reads a JSON interface: the list, its fields, Beijing times, links from templates", () => {
    const data = { code: 0, data: { list: [
      { id: 7, title: "寒假放假安排", publishTime: "2026-11-20 10:00:00", url: "/n/7.html", cover: "https://x.cn/i/7.jpg", summary: "各学院：寒假自 1 月 12 日开始，请各单位做好安排。".repeat(2), author: { name: "教务处" } },
      { id: 8, title: "奖学金公示", publishTime: "2026-11-19 16:30:00", url: "/n/8.html", cover: "https://x.cn/i/8.jpg", summary: "经评审，现将名单公示如下，公示期为五个工作日。".repeat(2), author: { name: "学生处" } },
    ] } };
    const rule = suggestJsonRule(data)!;
    expect(rule).toEqual({ items: "data.list", title: "title", link: "url", date: "publishTime", content: "summary", image: "cover", author: "author.name", id: "id" });
    const items = jsonItems(data, rule, "https://jwc.example.cn", parseLooseDate);
    expect(items[0]).toMatchObject({ title: "寒假放假安排", url: "https://jwc.example.cn/n/7.html", guid: "json:7", author: "教务处", publishedAt: Date.parse("2026-11-20T02:00:00Z") });
    expect(fill("https://x.cn/news/{id}?c={cat.name}", { id: 9, cat: { name: "通知 公告" } })).toBe("https://x.cn/news/9?c=%E9%80%9A%E7%9F%A5%20%E5%85%AC%E5%91%8A");
    expect(suggestJsonRule({ ok: true, count: 3 })).toBeNull();
  });

  it("tells what changed on a watched page", () => {
    const { document } = parseHTML("<body><div id=n><h2>公告</h2><ul><li>一号通知</li><li>二号通知<br>附件</li></ul><script>x</script></div></body>");
    expect(pageLines(document.getElementById("n")!)).toEqual(["公告", "一号通知", "二号通知", "附件", "x"]);
    expect(diffLines(["公告", "一号通知"], ["公告", "三号通知"])).toEqual({ added: ["三号通知"], removed: ["一号通知"] });
  });

  it("takes pushed messages in whatever shape they come", () => {
    const [a] = pushedItems({ title: "快递到了", text: "放在南门\nhttps://example.com/p/1", id: "x1" });
    expect(a).toMatchObject({ guid: "push:x1", title: "快递到了", contentHtml: '<p>放在南门<br><a href="https://example.com/p/1">https://example.com/p/1</a></p>' });
    expect(pushedItems({ title: "Server酱", desp: "**正文**" })[0].contentHtml).toBe("<p>**正文**</p>");
    expect(pushedItems("第一行是标题\n其余是正文")[0]).toMatchObject({ title: "第一行是标题", contentHtml: "<p>其余是正文</p>" });
    expect(pushedItems([{ url: "https://example.com/a" }, { nothing: 1 }]).map((i) => i.title)).toEqual(["https://example.com/a"]);
  });

  it("says what a network failure means", () => {
    expect(effectiveProxy({ proxy: "manual", url: "http://127.0.0.1:7897", bypass: "" })).toBe("http://127.0.0.1:7897");
    expect(effectiveProxy({ proxy: "off", url: "http://x", bypass: "" })).toBe("");
    expect(effectiveProxy({ proxy: "system", url: "", bypass: "" }, { HTTPS_PROXY: "http://10.0.0.1:8080" })).toBe("http://10.0.0.1:8080");
    expect(describeNetworkError("ENOTFOUND", "https://cn.nikkei.com/")).toMatch(/找不到 cn\.nikkei\.com：域名解析失败。.*设置 → 网络/);
  });
});

describe("subscribing to the stand-in site", () => {
  let server: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let auth = "";
  let dataDir = "";
  let notice = "<li>一号通知</li>";
  const FEED = `<?xml version="1.0" encoding="utf-8"?><?xml-stylesheet href="/rss.css" type="text/css"?><rss version=""><channel><title>站点新闻</title><link>https://example.com/</link>
    <item><title>第一条</title><link>https://example.com/1</link><pubDate>Wed, 25 Nov 2026 02:55:14 +0000</pubDate></item>
    <item><title>第二条</title><link>https://example.com/2</link><pubDate>Wed, 25 Nov 2026 01:55:14 +0000</pubDate></item></channel></rss>`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(body);
      };
      if (req.url === "/") return send(200, "text/html", `<html><head><title>站点</title></head><body><a href="/rss.html">RSS</a><p>欢迎</p></body></html>`);
      // the feed lives at an .html address, as 日经中文网's does
      if (req.url === "/rss.html") return send(200, "application/xml", FEED);
      if (req.url === "/api/list") return send(200, "application/json", JSON.stringify({ data: { list: [{ id: 1, title: "接口里的第一条", url: "/a/1" }, { id: 2, title: "接口里的第二条", url: "/a/2" }] } }));
      if (req.url === "/guarded") return send(202, "text/html", "", { "x-amzn-waf-action": "challenge" });
      if (req.url === "/board") return send(200, "text/html", `<html><head><title>公告栏</title></head><body><div id="b"><ul>${notice}</ul></div><footer>访问量 ${Math.random()}</footer></body></html>`);
      send(404, "text/plain", "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-sources-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
    auth = `Bearer ${ensureCliToken(app)}`;
    web = createHttp(app);
  });

  afterAll(() => {
    server.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (p: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const res = await web.request(p, { method, headers: { authorization: auth, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  };

  it("finds a feed the page only links to, even at an .html address", async () => {
    const r = await call("/api/feeds/preview", "POST", { input: `${base}/` });
    expect(r.json).toMatchObject({ kind: "feed", candidates: [{ url: `${base}/rss.html`, title: "站点新闻" }] });
  });

  it("reads a JSON interface pasted as an address", async () => {
    const r = await call("/api/feeds/preview", "POST", { input: `${base}/api/list` });
    expect(r.json).toMatchObject({ kind: "plugin", json: { url: `${base}/api/list`, items: "data.list", title: "title", link: "url" } });
    expect(r.json.items.map((i: { title: string; url: string }) => [i.title, i.url])).toEqual([["接口里的第一条", `${base}/a/1`], ["接口里的第二条", `${base}/a/2`]]);
  });

  it("names a bot check instead of failing to parse", async () => {
    const r = await call("/api/feeds/preview", "POST", { input: `${base}/guarded` });
    expect(r.json).toMatchObject({ error: "bot_check", vendor: "AWS WAF" });
    expect(r.json.message).toMatch(/防护（AWS WAF）拦下了服务器的请求/);
  });

  it("watches a page and records what changed", async () => {
    const sub = await call("/api/feeds", "POST", { input: "plugin:watch", kind: "plugin", config: { plugin: { id: "watch", params: { url: `${base}/board`, selector: "#b" } } } });
    expect(sub.json).toMatchObject({ added: 1, feed: { title: "公告栏" } });
    notice = "<li>一号通知</li><li>二号通知：期末考试安排</li>";
    const changed = await refreshFeed(app, sub.json.feed.id);
    expect(changed.error).toBeUndefined();
    expect(changed.added).toBe(1);
    expect((await refreshFeed(app, sub.json.feed.id)).added).toBe(0); // the footer's counter is outside #b
    const titles = app.db.all<{ title: string }>("select title from entries where feed_id = ? order by id", sub.json.feed.id).map((e) => e.title);
    expect(titles).toEqual(["公告栏（开始关注）", "公告栏：二号通知：期末考试安排"]);
  });

  it("takes messages at a push address whose key stays out of addresses and exports", async () => {
    const sub = await call("/api/feeds", "POST", { input: "plugin:inbox", kind: "plugin", title: "手机通知", config: { plugin: { id: "inbox", params: {} } } });
    const token: string = sub.json.feed.config.plugin.params.token;
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(sub.json.feed.url).not.toContain(token);
    const push = (body: unknown, type = "application/json") => web.request(`/in/${token}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect(await (await push({ title: "快递到了", text: "南门" })).json()).toEqual({ ok: true, added: 1 });
    expect(await (await push("纯文本标题\n内容", "text/plain")).json()).toEqual({ ok: true, added: 1 });
    expect((await web.request(`/in/${token}?title=${encodeURIComponent("从 GET 来的")}`)).status).toBe(200);
    expect((await web.request("/in/not-a-real-key-at-all", { method: "POST", body: "{}" })).status).toBe(404);
    expect(app.db.all<{ title: string }>("select title from entries where feed_id = ? order by id", sub.json.feed.id).map((e) => e.title)).toEqual(["快递到了", "纯文本标题", "从 GET 来的"]);
    expect((await call("/api/opml")).text).not.toContain(token);
  });

  it("gives every subscription an RSS address with a key of its own", async () => {
    const { json } = await call("/api/outputs/key");
    expect(json.key).toMatch(/^out_/);
    const feed = app.feeds.list().find((f) => f.title === "手机通知")!;
    const out = await web.request(`/out/feed/${feed.id}.xml?key=${json.key}`);
    expect(out.status).toBe(200);
    expect(await out.text()).toContain("快递到了");
    expect((await web.request(`/out/feed/${feed.id}.xml?key=out_wrong`)).status).toBe(401);
    // a new key retires the old addresses; it opens nothing but /out
    const fresh = (await call("/api/outputs/key", "POST")).json.key;
    expect((await web.request(`/out/feed/${feed.id}.xml?key=${json.key}`)).status).toBe(401);
    expect((await web.request("/api/feeds", { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(401);
  });

  it("keeps the proxy setting tidy", async () => {
    const r = await call("/api/settings", "PATCH", { network: { proxy: "manual", url: " 127.0.0.1:7897 " } });
    expect(r.json.network).toMatchObject({ proxy: "manual", url: "http://127.0.0.1:7897" });
    // the proxy needs Node 24 (http.setGlobalProxyFromEnv); on Node 22 the setting is kept and the page says so
    const canProxy = typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function";
    expect((await call("/api/network")).json).toMatchObject({ supported: canProxy });
  });
});
