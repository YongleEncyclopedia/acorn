/**
 * 交我办: messages from the SJTU portal, read with a jAccount sign-in that renews the portal's short session the
 * way the browser does (portal → jAccount → back with a code). Two stand-in servers play the portal and jAccount.
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
import { connect } from "../src/server/accounts/browser-login.ts";
import { cookiesFor, jarFromBrowser, jwbService, keepCookies, messageItem, shanghai } from "../src/server/feeds/builtin/jwb.ts";
import type { Jar } from "../src/server/store/accounts.ts";

process.env.ACORN_SILENT = "1";

describe("cookies across the portal and jAccount", () => {
  it("sends a host its own cookies and its domain's, and keeps what responses set", () => {
    const jar: Jar = {};
    keepCookies(jar, "my.sjtu.edu.cn", ["JSESSIONID=a1; Path=/; HttpOnly", "cid=c9; Domain=.sjtu.edu.cn; Path=/", "evil=x; Domain=example.com"]);
    keepCookies(jar, "jaccount.sjtu.edu.cn", ["JSESSIONID=j1; Path=/jaccount"]);
    expect(jar).toEqual({ "my.sjtu.edu.cn": { JSESSIONID: "a1" }, ".sjtu.edu.cn": { cid: "c9" }, "jaccount.sjtu.edu.cn": { JSESSIONID: "j1" } });
    expect(cookiesFor(jar, "my.sjtu.edu.cn")).toBe("JSESSIONID=a1; cid=c9");
    expect(cookiesFor(jar, "jaccount.sjtu.edu.cn")).toBe("cid=c9; JSESSIONID=j1");
    expect(cookiesFor(jar, "elsewhere.example")).toBe("");
    // deleted and expired cookies go
    keepCookies(jar, "my.sjtu.edu.cn", ["JSESSIONID=; Max-Age=0", "cid=old; Domain=sjtu.edu.cn; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    expect(cookiesFor(jar, "my.sjtu.edu.cn")).toBe("");
  });

  it("takes the browser's sign-in, and a JAAuthCookie pasted by hand", () => {
    const jar = jarFromBrowser([
      { name: "JSESSIONID", value: "p", domain: "my.sjtu.edu.cn" },
      { name: "JAAuthCookie", value: "ja", domain: "jaccount.sjtu.edu.cn" },
      { name: "cid", value: "c", domain: ".sjtu.edu.cn" },
      { name: "other", value: "o", domain: ".example.com" },
    ]);
    expect(jar).toEqual({ "my.sjtu.edu.cn": { JSESSIONID: "p" }, "jaccount.sjtu.edu.cn": { JAAuthCookie: "ja" }, ".sjtu.edu.cn": { cid: "c" } });
    expect(jwbService.fromManual!(" abc123 ")).toEqual({ jar: { "jaccount.sjtu.edu.cn": { JAAuthCookie: "abc123" } } });
    expect(jwbService.fromManual!("JAAuthCookie=abc; JATrustCookie=t")).toEqual({ jar: { "jaccount.sjtu.edu.cn": { JAAuthCookie: "abc", JATrustCookie: "t" } } });
  });
});

describe("a 交我办 message", () => {
  const group = { groupId: "G1", groupName: "学生事务管理系统", isGroup: false };
  it("reads Shanghai times wherever the server runs", () => {
    expect(shanghai("2026-10-25 09:01:15")).toBe(Date.parse("2026-10-25T01:01:15Z"));
    expect(shanghai(undefined)).toBeNull();
  });

  it("becomes an article: its fields, its links, and where it opens", () => {
    const canvas = messageItem(
      {
        messageId: "m1",
        title: "ME6109JSU2026",
        description: "Assignment #2",
        pushTitle: "课程通知",
        createTime: "2026-05-28 06:22:49",
        authClient: { name: "Canvas日历通知" },
        context: [
          { key: "截止时间", value: "2026-05-28 16:00:00" },
          { key: "内容", value: "HMWK02.pdf <b>" },
          { key: "地址", value: "https://oc.sjtu.edu.cn/courses/92327/assignments/411466" },
        ],
      },
      group,
      "https://my.sjtu.edu.cn",
    );
    expect(canvas).toMatchObject({ title: "ME6109JSU2026 · Assignment #2", url: "https://oc.sjtu.edu.cn/courses/92327/assignments/411466", guid: "jwb:m1", author: "Canvas日历通知", publishedAt: Date.parse("2026-05-27T22:22:49Z") });
    expect(canvas.content).toBe('<p><b>截止时间：</b>2026-05-28 16:00:00</p><p>HMWK02.pdf &lt;b&gt;</p><p><b>地址：</b><a href="https://oc.sjtu.edu.cn/courses/92327/assignments/411466">oc.sjtu.edu.cn/courses/92327/assignments/411466</a></p>');
    const notice = messageItem({ messageId: "m2", description: "【学生军训拉练活动通告】", pushContent: "全体师生：\n详见 https://www.sjtu.edu.cn/tzgg/1.html。" }, group, "https://my.sjtu.edu.cn");
    expect(notice.title).toBe("【学生军训拉练活动通告】");
    expect(notice.url).toBe("https://my.sjtu.edu.cn/ui/message/detail?name=%E5%AD%A6%E7%94%9F%E4%BA%8B%E5%8A%A1%E7%AE%A1%E7%90%86%E7%B3%BB%E7%BB%9F&groupId=G1&isGroup=false&isRead=true");
    expect(notice.content).toBe('<p>全体师生：<br>详见 <a href="https://www.sjtu.edu.cn/tzgg/1.html">www.sjtu.edu.cn/tzgg/1.html</a>。</p>');
    // a long sign-up link shows as its site and the start of its path
    const signup = messageItem({ messageId: "m3", description: "报名成功", context: [{ value: `https://events.gc.sjtu.edu.cn/n/${"x".repeat(120)}` }] }, group, "https://my.sjtu.edu.cn");
    expect(signup.content).toBe(`<p><a href="https://events.gc.sjtu.edu.cn/n/${"x".repeat(120)}">events.gc.sjtu.edu.cn/n/${"x".repeat(24)}…</a></p>`);
  });
});

describe("signing in to 交我办 and reading its messages", () => {
  let portal: http.Server;
  let jaccount: http.Server;
  let P = "";
  let J = "";
  let app: App;
  let dataDir = "";
  // what the stand-ins accept; tests change them to end sessions
  let session = "s1";
  let jaAuth = "ja-valid";
  const asked: string[] = [];

  const recent = (days: number) => {
    const d = new Date(Date.now() - days * 86_400_000 + 8 * 3_600_000);
    return d.toISOString().slice(0, 19).replace("T", " ");
  };
  const cookieOf = (req: http.IncomingMessage, name: string) => (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

  beforeAll(async () => {
    portal = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      asked.push(url.pathname + (url.searchParams.get("groupId") ? `#${url.searchParams.get("groupId")}` : ""));
      const json = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errno: 0, message: "success", ...(data as object) }));
      };
      const signedIn = cookieOf(req, "JSESSIONID") === session;
      if (url.pathname === "/ui/task/") {
        if (signedIn) {
          res.writeHead(200, { "content-type": "text/html" });
          return res.end("<title>交我办</title>");
        }
        if (url.searchParams.get("code") === "ok") {
          res.writeHead(302, { location: "/ui/task/", "set-cookie": [`JSESSIONID=${session}; Path=/; HttpOnly`, "keepalive=k; Path=/"] });
          return res.end();
        }
        res.writeHead(302, { location: `${J}/oauth2/authorize?response_type=code&client_id=jwb&redirect_uri=${encodeURIComponent(`${P}/ui/task/`)}`, "set-cookie": ["JSESSIONID=pending; Path=/"] });
        return res.end();
      }
      if (!signedIn) {
        res.writeHead(401);
        return res.end();
      }
      if (url.pathname === "/api/account") return json({ entities: [{ name: "小松", account: "xiaosong" }] });
      if (url.pathname === "/api/jwbmessage/group")
        return json({
          total: 3,
          entities: [
            { groupId: "G1", groupName: "学生事务管理系统", isGroup: false, createTime: recent(1) },
            { groupId: "G2", groupName: "网络信息中心", isGroup: true, createTime: recent(2) },
            { groupId: "G3", groupName: "体育系", isGroup: false, createTime: "2025-10-18 18:22:36" },
          ],
        });
      if (url.pathname === "/api/jwbmessage/messagelist") {
        const g = url.searchParams.get("groupId");
        if (g === "G1") return json({ total: 1, entities: [{ messageId: "a", description: "助学贷款信息登记通知", createTime: recent(1), authClient: { name: "学生事务管理系统" }, context: [{ key: "内容", value: "请于本周内完成登记。" }] }] });
        if (g === "G2")
          return json({
            total: 2,
            entities: [
              { messageId: "b", description: "验证码 027025", createTime: recent(2) },
              { messageId: "c", description: "校园网维护通知", createTime: recent(3), pushContent: "周六凌晨维护" },
            ],
          });
        return json({ total: 1, entities: [{ messageId: "d", description: "赛事报名提醒", createTime: "2025-10-18 18:22:36" }] });
      }
      res.writeHead(404);
      res.end();
    });
    jaccount = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname === "/oauth2/authorize") {
        // still signed in to jAccount: straight back to the portal with a code
        if (cookieOf(req, "JAAuthCookie") === jaAuth) res.writeHead(302, { location: `${P}/ui/task/?code=ok&state=s`, "set-cookie": ["JSESSIONID=ja-session; Path=/jaccount"] });
        else res.writeHead(302, { location: "/jaccount/jalogin?sid=1" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>jAccount 登录</title><form>密码</form>");
    });
    await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => jaccount.listen(0, "127.0.0.1", r));
    P = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
    J = `http://127.0.0.1:${(jaccount.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-jwb-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
  });

  afterAll(() => {
    portal.close();
    jaccount.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const jarHost = () => new URL(J).host;
  const portalSession = () => app.accounts.credential(app.accounts.list().find((a) => a.service === "jwb")!.id)!.jar?.[new URL(P).host]?.JSESSIONID;

  it("signs in with the jAccount cookie alone, getting a portal session through jAccount", async () => {
    const account = await connect(app, jwbService, P, { jar: { [jarHost()]: { JAAuthCookie: "ja-valid" } } });
    expect(account).toMatchObject({ service: "jwb", name: "小松", status: "ok" });
    expect(portalSession()).toBe("s1");
  });

  it("offers its sources, and reads the recent ones without one-time codes", async () => {
    const web = createHttp(app);
    const auth = { authorization: `Bearer ${ensureCliToken(app)}`, "content-type": "application/json" };
    const id = app.accounts.list().find((a) => a.service === "jwb")!.id;
    const choices = await (await web.request(`/api/plugins/jwb/choices?key=group&account=${id}`, { headers: auth })).json();
    expect(choices).toEqual([
      { value: "all", label: "全部消息" },
      { value: "G1", label: "学生事务管理系统" },
      { value: "G2", label: "网络信息中心" },
      { value: "G3", label: "体育系" },
    ]);
    const subscribe = async (group: string) => (await web.request("/api/feeds", { method: "POST", headers: auth, body: JSON.stringify({ input: "plugin:jwb", kind: "plugin", config: { plugin: { id: "jwb", params: { group }, account: id } } }) })).json();
    asked.length = 0;
    const all = await subscribe("all");
    expect(all).toMatchObject({ existed: false, added: 2, feed: { title: "交我办", fullText: "never" } });
    const titles = app.db.all<{ title: string; author: string }>("select title, author from entries where feed_id = ? order by published_at desc", all.feed.id);
    expect(titles).toEqual([
      { title: "助学贷款信息登记通知", author: "学生事务管理系统" },
      { title: "校园网维护通知", author: "网络信息中心" },
    ]);
    // a source quiet for months is not asked on every refresh
    expect(asked.filter((a) => a.startsWith("/api/jwbmessage/messagelist"))).toEqual(["/api/jwbmessage/messagelist#G1", "/api/jwbmessage/messagelist#G2"]);
    const one = await subscribe("G3");
    expect(one).toMatchObject({ added: 1, feed: { title: "交我办 · 体育系" } });
  });

  it("renews an ended portal session through jAccount, and keeps the new one", async () => {
    const feed = app.feeds.list().find((f) => f.title === "交我办")!;
    session = "s2";
    expect((await refreshFeed(app, feed.id)).error).toBeUndefined();
    expect(portalSession()).toBe("s2");
  });

  it("asks for a new sign-in when jAccount wants the password again", async () => {
    const feed = app.feeds.list().find((f) => f.title === "交我办")!;
    session = "s3";
    jaAuth = "ja-other";
    expect((await refreshFeed(app, feed.id)).error).toMatch(/交我办（jAccount）的登录已过期，请在 设置 → 账号 里重新登录/);
    expect(app.accounts.list().find((a) => a.service === "jwb")!.status).toBe("expired");
  });
});
