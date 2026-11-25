/**
 * 账号: signing in to platforms (知识星球, Canvas) and reading with the sign-in, against stand-in servers that
 * answer like the real APIs (知识星球 as RSSHub reads it, Canvas as documented). The browser sign-in needs
 * ego-browser and the user, and is tried by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { refreshFeed } from "../src/server/feeds/refresh.ts";
import { runPlugin } from "../src/server/feeds/plugins.ts";
import { archiveEntry } from "../src/server/archive/capture.ts";
import { recheckArchive } from "../src/server/archive/recheck.ts";
import { headline, topicItem, topicText, zsxqService } from "../src/server/feeds/builtin/zsxq.ts";
import { directFileLinks } from "../src/server/feeds/builtin/canvas.ts";
import type { Get } from "../src/server/accounts/services.ts";

process.env.ACORN_SILENT = "1";

const TOKEN = "zsxq-SECRET-token-1234";
// a 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const CANVAS = "canvas-SECRET-token-5678";

const TOPICS = [
  {
    topic_id: 9001,
    type: "talk",
    create_time: "2026-11-16T09:30:00.000+0800",
    talk: {
      owner: { name: "星主" },
      text: '今天聊 <e type="hashtag" hid="1" title="%23%E8%AF%BB%E4%B9%A6%23" /> 和 <e type="web" href="https%3A%2F%2Fexample.com%2Fa" title="%E4%B8%80%E7%AF%87%E6%96%87%E7%AB%A0" /> <e type="text_bold" title="%E9%87%8D%E7%82%B9" />\n第二行 <script>x</script>',
      images: [{ large: { url: "https://images.zsxq.com/a-large.jpg" }, thumbnail: { url: "https://images.zsxq.com/a-thumb.jpg" } }],
      files: [{ name: "讲义.pdf" }],
    },
  },
  {
    topic_id: 9002,
    type: "q&a",
    create_time: "2026-11-15T20:00:00.000+0800",
    question: { owner: { name: "球友" }, text: "怎么读论文？" },
    answered: true,
    answer: { owner: { name: "星主" }, text: "先看图表。" },
  },
];

describe("知识星球 topics", () => {
  it("turns marked-up text into safe HTML", () => {
    expect(topicText(TOPICS[0].talk!.text)).toBe('今天聊 #读书# 和 <a href="https://example.com/a">一篇文章</a> <b>重点</b><br>第二行 &lt;script&gt;x&lt;/script&gt;');
  });

  it("titles a topic by its first line, past a greeting (the API's own title is cut short)", () => {
    expect(headline("卡老师好！\n   我觉得我是一个情感淡薄的人，但情绪是正常的。")).toBe("我觉得我是一个情感淡薄的人，但情绪是正常的。");
    expect(headline("今天心情很好！\n明天见")).toBe("今天心情很好！");
    expect(headline("。（负面，谨慎观看）\n正文")).toBe("（负面，谨慎观看）");
    expect(headline("浑水宣布做空英伟达\n浑水宣布：……")).toBe("浑水宣布做空英伟达");
    expect(headline("长".repeat(70))).toBe(`${"长".repeat(40)}…`);
    // a long first line is told by its first sentence
    expect(headline("主持人问他最烦恼什么，刘德华回答：数学。“他们现在学的数学和我们那会学的完全不一样。”")).toBe("主持人问他最烦恼什么，刘德华回答：数学。");
    expect(topicItem({ topic_id: 1, type: "talk", title: "浑水宣布做空...", talk: { text: "浑水宣布做空英伟达\n正文" } }).title).toBe("浑水宣布做空英伟达");
    expect(topicItem({ topic_id: 2, type: "talk", title: "「图片」", talk: { images: [{ large: { url: "https://images.zsxq.com/p.jpg" } }] } }).title).toBe("图片");
  });

  it("makes an article of a topic, a question with its answer", () => {
    const a = topicItem(TOPICS[0]);
    expect(a).toMatchObject({ title: "今天聊 #读书# 和 一篇文章 重点", url: "https://wx.zsxq.com/topic/9001", guid: "zsxq:9001", author: "星主", image: "https://images.zsxq.com/a-large.jpg" });
    expect(a.content).toContain('<img src="https://images.zsxq.com/a-large.jpg">');
    expect(a.content).toContain("📎 讲义.pdf");
    const q = topicItem(TOPICS[1]);
    expect(q).toMatchObject({ title: "问：怎么读论文？", author: "星主" });
    expect(q.content).toBe("<blockquote><p>球友 提问：</p>怎么读论文？</blockquote><p><b>星主 回答：</b></p>先看图表。");
  });

  it("asks again when the API says 1059, and tells a refused sign-in apart", async () => {
    let calls = 0;
    const get: Get = async (_url, headers) => {
      calls++;
      if (calls === 1) return { status: 200, text: JSON.stringify({ succeeded: false, code: 1059 }) };
      return headers.cookie === `zsxq_access_token=${TOKEN}` ? { status: 200, text: JSON.stringify({ succeeded: true, resp_data: { user: { name: "小松" } } }) } : { status: 200, text: JSON.stringify({ succeeded: false, code: 401, info: "请重新登录" }) };
    };
    expect(await zsxqService.whoami({ token: TOKEN }, "http://zsxq.test", get)).toBe("小松");
    expect(calls).toBe(2);
    await expect(zsxqService.whoami({ token: "old" }, "http://zsxq.test", get)).rejects.toMatchObject({ name: "LoginExpiredError" });
  });
});

describe("Canvas files", () => {
  it("links files to their download, so they open from the reader and archiving keeps them", () => {
    const o = "https://oc.sjtu.edu.cn";
    expect(directFileLinks('<a href="https://oc.sjtu.edu.cn/courses/1/files/22?verifier=abc&amp;wrap=1">讲义.pdf</a>', o)).toBe('<a href="https://oc.sjtu.edu.cn/courses/1/files/22/download?verifier=abc&amp;download_frd=1">讲义.pdf</a>');
    expect(directFileLinks('<a href="/courses/1/files/23/preview">x</a>', o)).toBe('<a href="https://oc.sjtu.edu.cn/courses/1/files/23/download?download_frd=1">x</a>');
    // already a download, or somewhere else: left alone
    for (const html of ['<a href="/courses/1/files/23/download?verifier=q">y</a>', '<a href="https://elsewhere.example/files/1">z</a>']) expect(directFileLinks(html, o)).toBe(html);
  });
});

describe("signing in and reading with the sign-in", () => {
  let server: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let auth = "";
  let dataDir = "";
  let zsxqAccepts = TOKEN;
  const hits: string[] = [];
  const imageAuth: Record<string, string | null> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      hits.push(url.pathname);
      // pictures: a Canvas file only loads signed in; anything else must never get the sign-in
      if (url.pathname === "/courses/11/files/77/preview" || url.pathname === "/elsewhere.png" || url.pathname === "/img/post.png") {
        imageAuth[url.pathname] = req.headers.authorization || req.headers.cookie || null;
        if (url.pathname.startsWith("/courses/") && req.headers.authorization !== `Bearer ${CANVAS}`) {
          res.writeHead(302, { location: "/login/canvas" });
          return res.end();
        }
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      // 知识星球's API (the plugin talks to the account's address when it is not wx.zsxq.com)
      if (url.pathname.startsWith("/v2/")) {
        if (req.headers.cookie !== `zsxq_access_token=${zsxqAccepts}`) return json(200, { succeeded: false, code: 401, info: "请重新登录" });
        const ok = (data: unknown) => json(200, { succeeded: true, resp_data: data });
        if (url.pathname === "/v2/users/self") return ok({ user: { name: "小松" } });
        if (url.pathname === "/v2/groups") return ok({ groups: [{ group_id: 123, name: "读书会" }, { group_id: 456, name: "写作课" }] });
        const g = url.pathname.match(/^\/v2\/groups\/(\d+)(\/topics)?$/);
        if (g && !g[2]) return ok({ group: { name: g[1] === "123" ? "读书会" : "写作课", description: "一起读书" } });
        // 写作课 has a post that is only a picture
        if (g && g[2]) return ok({ topics: g[1] === "123" ? TOPICS : [{ topic_id: 9100, type: "talk", create_time: "2026-11-16T10:00:00.000+0800", talk: { owner: { name: "星主" }, images: [{ large: { url: `${base}/img/post.png` } }] } }] });
      }
      // Canvas's REST API
      if (url.pathname.startsWith("/api/v1/")) {
        if (req.headers.authorization !== `Bearer ${CANVAS}`) return json(401, { errors: [{ message: "Invalid access token." }] });
        if (url.pathname === "/api/v1/users/self") return json(200, { id: 1, name: "张三丰", short_name: "张三" });
        if (url.pathname === "/api/v1/courses") {
          // two pages, as Canvas paginates
          if (url.searchParams.get("page") === "2") return json(200, [{ id: 22, name: "数据结构" }]);
          return json(200, [{ id: 11, name: "高等数学" }], { link: `<${base}/api/v1/courses?enrollment_state=active&per_page=100&page=2>; rel="next", <${base}/api/v1/courses?page=1>; rel="first"` });
        }
        if (url.pathname === "/api/v1/users/self/activity_stream")
          return json(200, [
            { id: 1, type: "Announcement", title: "期中考试安排", message: "<p>周三考试</p>", html_url: `${base}/courses/11/discussion_topics/5`, created_at: "2026-11-16T02:00:00Z", course_id: 11 },
            { id: 2, type: "Submission", title: "作业 3", html_url: "/courses/22/assignments/7/submissions/1", created_at: "2026-11-15T02:00:00Z", course_id: 22, grade: "A", score: 95, assignment: { name: "作业 3" }, submission_comments: [{ author_name: "李老师", comment: "做得好" }] },
          ]);
        if (url.pathname === "/api/v1/announcements") {
          expect(url.searchParams.getAll("context_codes[]")).toEqual(["course_11", "course_22"]);
          // without an end date Canvas stops 28 days after the start date
          expect(Date.parse(url.searchParams.get("end_date") || "")).toBeGreaterThan(Date.now());
          return json(200, [{ id: 5, title: "期中考试安排", message: "<p>周三考试</p>", html_url: `${base}/courses/11/discussion_topics/5`, posted_at: "2026-11-16T02:00:00Z", context_code: "course_11", author: { display_name: "王老师" } }]);
        }
        if (url.pathname === "/api/v1/planner/items")
          return json(200, [
            { plannable_id: 7, plannable_type: "assignment", plannable_date: "2026-11-20T15:59:00Z", plannable: { title: "作业 4", due_at: "2026-11-20T15:59:00Z", points_possible: 10 }, html_url: "/courses/22/assignments/8", context_name: "数据结构", submissions: { submitted: false, missing: false } },
            { plannable_id: 8, plannable_type: "planner_note", plannable: { title: "自己的备忘" } },
          ]);
      }
      json(404, { error: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-accounts-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
    auth = `Bearer ${ensureCliToken(app)}`;
    web = createHttp(app);
  });

  afterAll(() => {
    server.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (p: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await web.request(p, { method: init.method || "GET", headers: { authorization: auth, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: res.status, text: await res.text() };
  };
  const get = async (p: string) => JSON.parse((await call(p)).text);
  const post = async (p: string, body: unknown) => {
    const r = await call(p, { method: "POST", body });
    return { status: r.status, body: JSON.parse(r.text) };
  };

  it("lists the platforms, and signs in to Canvas with a token", async () => {
    const { services, accounts } = await get("/api/accounts");
    expect(services.map((s: { id: string }) => s.id)).toEqual(["zsxq", "canvas", "jwb"]);
    // no ego-browser here: only signing in by hand is offered
    expect(services.every((s: { browserLogin: boolean }) => !s.browserLogin)).toBe(true);
    expect(accounts).toEqual([]);
    expect(await post("/api/accounts", { service: "canvas", origin: `${base}/courses`, token: "wrong" })).toMatchObject({ status: 422 });
    const ok = await post("/api/accounts", { service: "canvas", origin: base, token: ` ${CANVAS} ` });
    expect(ok).toMatchObject({ status: 200, body: { account: { service: "canvas", origin: base, name: "张三", status: "ok", feeds: 0 } } });
    expect(await post("/api/accounts/browser", { service: "zsxq" })).toMatchObject({ status: 409 });
  });

  it("reads Canvas: the stream, announcements and what is due", async () => {
    const acc = app.accounts.list().find((a) => a.service === "canvas")!;
    const c = app.accounts.credential(acc.id)!;
    const account = { id: acc.id, origin: acc.origin, name: acc.name, token: c.token };
    const stream = await runPlugin(app.cfg.pluginsDir, "canvas", { what: "stream" }, "test", account);
    expect(stream.title).toBe("Canvas · 全部动态");
    expect(stream.items.map((i) => [i.title, i.author, i.url])).toEqual([
      ["公告｜期中考试安排", "高等数学", `${base}/courses/11/discussion_topics/5`],
      ["作业｜作业 3 · 成绩 A", "数据结构", `${base}/courses/22/assignments/7/submissions/1`],
    ]);
    expect(stream.items[1].contentHtml).toBe("<p>成绩：A（95 分）</p><p><b>李老师：</b>做得好</p>");
    const news = await runPlugin(app.cfg.pluginsDir, "canvas", { what: "announcements" }, "test", account);
    expect(news.items).toMatchObject([{ title: "期中考试安排", author: "高等数学 · 王老师", publishedAt: Date.parse("2026-11-16T02:00:00Z") }]);
    const due = await runPlugin(app.cfg.pluginsDir, "canvas", { what: "todo" }, "test", account);
    expect(due.items).toHaveLength(1); // a note of one's own is not something due
    expect(due.items[0].title).toMatch(/^作业｜作业 4（.+ 截止）$/);
    expect(due.items[0].contentHtml).toContain("状态：未提交");
  });

  it("offers the 星球 the account joined, and subscribes to each one apart", async () => {
    const zsxq = app.accounts.save("zsxq", base, "小松", { token: TOKEN });
    const choices = await get(`/api/plugins/zsxq/choices?key=group&account=${zsxq.id}`);
    expect(choices).toEqual([{ value: "123", label: "读书会" }, { value: "456", label: "写作课" }]);
    const one = await post("/api/feeds", { input: "plugin:zsxq", kind: "plugin", config: { plugin: { id: "zsxq", params: { group: "123", scope: "all" }, account: zsxq.id } } });
    const two = await post("/api/feeds", { input: "plugin:zsxq", kind: "plugin", config: { plugin: { id: "zsxq", params: { group: "456" }, account: zsxq.id } } });
    expect(one.body).toMatchObject({ existed: false, added: 2, feed: { title: "读书会", url: "zsxq?group=123&scope=all", fullText: "never" } });
    expect(two.body).toMatchObject({ existed: false, added: 1, feed: { title: "写作课", url: "zsxq?group=456" } });
    expect(app.accounts.get(zsxq.id)!.feeds).toBe(2);
  });

  it("waits for a new sign-in once the platform refuses the old one", async () => {
    const feed = app.feeds.list().find((f) => f.url === "zsxq?group=123&scope=all")!;
    zsxqAccepts = "a-new-token";
    const r = await refreshFeed(app, feed.id);
    expect(r.error).toMatch(/知识星球的登录已过期，请在 设置 → 账号 里重新登录/);
    const acc = app.accounts.list().find((a) => a.service === "zsxq")!;
    expect(acc).toMatchObject({ status: "expired" });
    // refused sign-ins are not tried again until the user signs in anew
    const before = hits.length;
    expect((await refreshFeed(app, feed.id)).error).toMatch(/重新登录/);
    expect(hits.length).toBe(before);
    app.accounts.save("zsxq", base, "小松", { token: "a-new-token" });
    expect((await refreshFeed(app, feed.id)).error).toBeUndefined();
    expect(app.accounts.get(acc.id)!.status).toBe("ok");
  });

  it("archives a signed-in post from the feed, even a picture alone, and never rechecks its page", async () => {
    const entry = app.db.get<{ id: number }>("select id from entries where guid = 'zsxq:9100'")!;
    const before = hits.length;
    const saved = (await archiveEntry(app, entry.id))!;
    expect(saved).toMatchObject({ created: true, warnings: [] });
    const snap = app.archives.latestSnapshot(saved.archiveId)!;
    expect(snap.method).toBe("feed");
    // the picture was kept; the post's page (a login or an empty shell for the server) was never asked for
    expect(hits.slice(before)).toEqual(["/img/post.png"]);
    expect(await recheckArchive(app, saved.archiveId)).toMatchObject({ status: "unknown", reason: expect.stringMatching(/登录/) });
    expect(app.db.get<{ n: number }>("select count(*) as n from snapshots where archive_id = ?", saved.archiveId)!.n).toBe(1);
  });

  it("loads a Canvas file's picture signed in, and sends the sign-in nowhere else", async () => {
    const img = async (u: string) => (await web.request(`/api/img?u=${encodeURIComponent(u)}`, { headers: { authorization: auth } })).status;
    expect(await img(`${base}/courses/11/files/77/preview`)).toBe(200);
    expect(imageAuth["/courses/11/files/77/preview"]).toBe(`Bearer ${CANVAS}`);
    expect(await img(`${base}/elsewhere.png`)).toBe(200);
    expect(imageAuth["/elsewhere.png"]).toBeNull();
  });

  it("never hands a token or cookie to anyone", async () => {
    for (const p of ["/api/accounts", "/api/feeds", "/api/bootstrap", "/api/settings"]) {
      const text = (await call(p)).text;
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(CANVAS);
      expect(text).not.toContain("a-new-token");
    }
    const { plugins } = await get("/api/bootstrap");
    expect(plugins.slice(0, 2)).toMatchObject([
      { id: "zsxq", builtin: true, account: "zsxq", params: [{ key: "group", fromAccount: true }, { key: "scope" }] },
      { id: "canvas", builtin: true, account: "canvas" },
    ]);
  });
});
