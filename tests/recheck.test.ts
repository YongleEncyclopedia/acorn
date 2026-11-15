/**
 * Rechecking archived pages against a fixture site on localhost: short live pages that quote a deletion phrase stay
 * alive, a page that still shows the archived text stays alive, a page replaced by a deletion notice (HTTP 200) is gone,
 * and a captcha in a page's place leaves it unknown instead of passing for a new version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createApp, type App } from "../src/server/app.ts";
import { capture } from "../src/server/archive/capture.ts";
import { recheckArchive } from "../src/server/archive/recheck.ts";
import { detectGone } from "../src/server/content/rules/index.ts";

process.env.ACORN_SILENT = "1";

const frame = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
  `<ul class="nav"><li><a href="/">首页</a></li><li><a href="/tzgg">通知公告</a></li></ul>${body}` +
  `<div class="foot"><p>版权所有 © 2026 示例学院　地址：示例市示例路 1 号</p><p>京ICP备00000000号</p></div></body></html>`;

const NOTICE = frame(
  "关于2027年寒假放假安排的通知",
  `<article><h1>关于2027年寒假放假安排的通知</h1><p>根据相关法律法规和学校工作安排，现将2027年寒假放假安排通知如下：</p>` +
    `<p>一、学生自2027年1月10日起放假，2月20日报到注册，2月23日正式上课。</p><p>二、假期间各单位安排值班，确保校园安全稳定。</p><p>特此通知。</p></article>`,
);
const ESSAY = frame(
  "链接会消失",
  `<article><h1>链接会消失</h1><p>三年前收藏的文章，如今点开十篇里有三篇只剩一行灰字：「该内容已被删除」。原文没了，评论也没了。</p>` +
    `<p>所以我开始自己存档：读到值得留下的文章，先存一份到硬盘上，连图片和附件一起，再慢慢读。</p></article>`,
);
const POST = frame(
  "记一次链接失效",
  `<article><h1>记一次链接失效</h1><p>上周想重读一篇讲松鼠贮藏习性的长文，点开收藏的链接，页面只剩下一句话。</p><p>好在当时顺手存了一份，原文和配图都还在，以后读到好文章还是先存下来。</p></article>`,
);
// The site's login box: 验证码 on a page does not make it a captcha page.
const LOGIN = `<form class="login"><label>用户名</label><input name="u"><label>密码</label><input name="p" type="password"><label>验证码</label><input name="code"><img src="/code.jpg"><button>登录</button></form>`;
const GONE = frame("提示信息", `${LOGIN}<div class="msg"><h2>该内容已被删除</h2><p><a href="/">返回首页</a></p></div>`);
const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"><p>Checking if the site connection is secure. This page refreshes once the check is complete.</p></div></body></html>`;

const pages: Record<string, string> = {
  "/notice": NOTICE,
  "/essay": ESSAY,
  "/post": POST,
  "/doomed": ESSAY.replaceAll("链接会消失", "将被删除的文章"),
  "/walled": ESSAY.replaceAll("链接会消失", "藏在验证后面的文章"),
  "/login": ESSAY.replaceAll("链接会消失", "有登录框的文章"),
};

let site: http.Server;
let base = "";
let app: App;
let dataDir = "";

beforeAll(async () => {
  site = http.createServer((req, res) => {
    const page = pages[req.url || ""];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(page ?? "not found");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-recheck-"));
  app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
});

afterAll(() => {
  site.close();
  app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const archive = async (p: string) => {
  const r = await capture(app, { url: `${base}${p}`, method: "fetch" });
  expect(app.archives.row(r.archiveId)!.source_status).toBe("alive");
  return r.archiveId;
};

describe("rechecking archived pages", () => {
  it("keeps short live pages that quote a deletion phrase", async () => {
    for (const p of ["/notice", "/essay"]) expect(await recheckArchive(app, await archive(p)), p).toEqual({ status: "alive" });
  });

  it("keeps a page that still shows the archived text, whatever else it says", async () => {
    const id = await archive("/post");
    pages["/post"] = POST.replace("</article>", "<p>更新：原帖现在只显示一行字——</p><p>该内容已被删除</p></article>");
    expect(detectGone(`${base}/post`, pages["/post"], 200)).toBe("该内容已被删除"); // on its own, a page this short reads like a deletion notice
    expect(await recheckArchive(app, id)).toMatchObject({ status: "changed" });
    expect(app.archives.row(id)!.source_status).toBe("changed");
    expect(app.archives.snapshots(id)).toHaveLength(2);
  });

  it("marks a page gone once a deletion notice replaces it", async () => {
    const id = await archive("/doomed");
    pages["/doomed"] = GONE;
    expect(await recheckArchive(app, id)).toEqual({ status: "gone", reason: "该内容已被删除" });
    expect(app.archives.row(id)!.source_status).toBe("gone");
    expect(app.archives.snapshots(id)).toHaveLength(1);
  });

  it("leaves the status unknown when a captcha stands in for the page", async () => {
    const id = await archive("/walled");
    pages["/walled"] = CHALLENGE;
    expect(await recheckArchive(app, id)).toEqual({ status: "unknown", reason: "网站开启了 Cloudflare 人机验证" });
    expect(app.archives.row(id)!.source_status).toBe("unknown");
    expect(app.archives.snapshots(id)).toHaveLength(1);
  });

  it("does not take a page with 验证码 in its login box for a captcha", async () => {
    const id = await archive("/login");
    pages["/login"] = pages["/login"].replace("<article>", `${LOGIN}<article>`);
    expect(await recheckArchive(app, id)).toEqual({ status: "alive" });
    pages["/login"] = pages["/login"].replace("</article>", "<p>补记：后来那篇文章在作者的新博客上重新发了出来，链接换了，内容一字未改。</p></article>");
    expect(await recheckArchive(app, id)).toEqual({ status: "changed", reason: "原文内容有变化，已保存新版本" });
    expect(app.archives.snapshots(id).map((s) => s.method)).toEqual(["fetch", "fetch"]);
  });
});
