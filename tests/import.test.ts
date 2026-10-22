/**
 * Moving in from other tools: reading export files, then the whole flow against a fixture site and a fake Internet
 * Archive on localhost — live links archived, a dead one rescued from the Wayback Machine, a walled one reported.
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
import { capture } from "../src/server/archive/capture.ts";
import { parseCsv, parseImport } from "../src/server/import/parse.ts";
import { importTick } from "../src/server/import/run.ts";
import type { ImportBatch, ImportItem, ImportPreview } from "../src/shared/types.ts";

process.env.ACORN_SILENT = "1";

describe("reading export files", () => {
  it("reads browser bookmarks with folders as tags, skipping bookmarklets and duplicates", () => {
    const p = parseImport(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1600000000" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
  <DL><p>
    <DT><H3>读书</H3>
    <DL><p>
      <DT><A HREF="https://a.example/alive" ADD_DATE="1578000000">活着的页面</A>
      <DD>一条备注
      <DT><A HREF="https://a.example/dead?utm_source=x" ADD_DATE="1578000001" TAGS="旧文,收藏">死掉的页面</A>
    </DL><p>
    <DT><A HREF="https://a.example/alive#top">重复</A>
    <DT><A HREF="http://192.168.1.1/admin">路由器</A>
    <DT><A HREF="javascript:void(0)">小书签</A>
  </DL><p>
</DL><p>`);
    expect(p.format).toBe("bookmarks");
    expect(p.skipped).toBe(2);
    expect(p.links.map((l) => l.url)).toEqual(["https://a.example/alive", "https://a.example/dead?utm_source=x", "http://192.168.1.1/admin"]);
    expect(p.links[0]).toMatchObject({ title: "活着的页面", tags: ["读书"], note: "一条备注", savedAt: 1578000000000 });
    expect(p.links[1].tags).toEqual(["读书", "旧文", "收藏"]);
  });

  it("knows Pocket, Instapaper, Raindrop and Readwise CSV files", () => {
    const pocket = parseImport(`title,url,time_added,tags,status\n"A, quoted title",https://p.example/1,1600000000,tag1|tag2,unread\n`);
    expect(pocket.format).toBe("pocket");
    expect(pocket.links[0]).toMatchObject({ title: "A, quoted title", tags: ["tag1", "tag2"], savedAt: 1600000000000 });

    const insta = parseImport(`URL,Title,Selection,Folder,Timestamp\nhttps://i.example/1,Title,"a ""quoted"" line",Unread,1600000000\nhttps://i.example/2,Two,,Essays,1600000001\n`);
    expect(insta.format).toBe("instapaper");
    expect(insta.links[0]).toMatchObject({ note: 'a "quoted" line', tags: [] });
    expect(insta.links[1].tags).toEqual(["Essays"]);

    const rain = parseImport(`id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite\n1,T,,,https://r.example/1,Reading/Later,"a, b",2021-03-04T05:06:07Z,https://r.example/c.png,,false\n`);
    expect(rain.format).toBe("raindrop");
    expect(rain.links[0].tags).toEqual(["Reading", "Later", "a", "b"]);
    expect(rain.links[0].savedAt).toBe(Date.UTC(2021, 2, 4, 5, 6, 7));

    const rw = parseImport(`Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen\nT,https://w.example/1,01abc,"['ai', 'read']",2024-01-02 03:04:05,0.5,new,false\n`);
    expect(rw.format).toBe("readwise");
    expect(rw.links[0].tags).toEqual(["ai", "read"]);
  });

  it("reads JSON dumps and bare text", () => {
    const j = parseImport(JSON.stringify({ list: { a: { given_url: "https://j.example/1", resolved_title: "One", time_added: "1600000000", tags: { x: {} } } } }));
    expect(j.format).toBe("json");
    expect(j.links).toHaveLength(1);
    expect(j.links[0].title).toBe("One");
    const t = parseImport("看看这个 https://t.example/1，还有 https://t.example/2。\nhttps://t.example/1");
    expect(t.format).toBe("text");
    expect(t.links.map((l) => l.url)).toEqual(["https://t.example/1", "https://t.example/2"]);
  });

  it("parses CSV with quotes, newlines inside fields and tabs", () => {
    expect(parseCsv('a,b\n"x\ny","he said ""hi"""\n')).toEqual([["a", "b"], ["x\ny", 'he said "hi"']]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("moving in", () => {
  let site: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let token = "";
  let dataDir = "";
  const ARTICLE = (title: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title} - 测试站</title><meta property="og:site_name" content="测试站"></head><body><article><h1>${title}</h1>
${Array.from({ length: 8 }, (_, i) => `<p>这是第 ${i + 1} 段正文。松鼠把橡果埋进土里，留到冬天慢慢吃，这段话用来测试正文提取是否正常。</p>`).join("\n")}
<p><a href="/web/20200102030405/${base}/other">另一篇</a></p></article></body></html>`;
  const WAYBACK_PAGE = () =>
    `<!doctype html><html><head><script type="text/javascript" src="https://web-static.archive.org/_static/js/bundle-playback.js?v=1" charset="utf-8"></script>
<script>__wm.init("https://web.archive.org/web");</script>
<!-- End Wayback Rewrite JS Include -->
${ARTICLE("死掉的页面").replace(/^<!doctype html><html><head>/, "")}`;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };
      if (url.pathname === "/alive" || url.pathname === "/already") return send(200, "text/html; charset=utf-8", ARTICLE(url.pathname === "/alive" ? "活着的页面" : "早就藏了"));
      if (url.pathname === "/dead") return send(404, "text/html", "<h1>404</h1>");
      if (url.pathname === "/wall") return send(403, "text/html", "<h1>forbidden</h1>");
      // the fake Internet Archive
      if (url.pathname === "/cdx/search/cdx") {
        const target = url.searchParams.get("url") || "";
        return send(200, "application/json", JSON.stringify(target.endsWith("/dead") ? [["timestamp", "original"], ["20200102030405", target]] : []));
      }
      if (url.pathname.startsWith("/web/20200102030405if_/")) return send(200, "text/html; charset=utf-8", WAYBACK_PAGE());
      send(404, "text/plain", "not found");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-import-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false, waybackBase: base }));
    token = ensureCliToken(app);
    web = createHttp(app);
    await capture(app, { url: `${base}/already`, method: "fetch" });
  });

  afterAll(() => {
    site.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const upload = (p: string, text: string, fields: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append("file", new File([text], "bookmarks.html", { type: "text/html" }));
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return web.request(p, { method: "POST", body: fd, headers: { authorization: `Bearer ${token}` } });
  };
  const json = async <T>(p: string, init: RequestInit = {}) =>
    (await (await web.request(p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })).json()) as T;
  const BOOKMARKS = () => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>书签栏</H3><DL><p><DT><H3>读书</H3><DL><p>
<DT><A HREF="${base}/alive" ADD_DATE="1578000000">活着的页面</A>
<DT><A HREF="${base}/dead" ADD_DATE="1578000001">死掉的页面</A>
</DL><p><DT><A HREF="${base}/wall">有墙的页面</A><DT><A HREF="${base}/already">早就藏了</A><DT><A HREF="javascript:void(0)">小书签</A></DL><p></DL><p>`;

  it("previews what a file holds before anything is fetched", async () => {
    const res = await upload("/api/imports/preview", BOOKMARKS());
    expect(res.status).toBe(200);
    const p = (await res.json()) as ImportPreview;
    expect(p).toMatchObject({ format: "bookmarks", total: 4, already: 1, skipped: 1 });
    expect(p.tags).toEqual([{ tag: "读书", count: 2 }]);
    expect(p.sample[0].title).toBe("活着的页面");
  });

  it("archives live links, rescues dead ones from the Internet Archive and reports the rest", { timeout: 30_000 }, async () => {
    const res = await upload("/api/imports", BOOKMARKS(), { tags: "搬家", wayback: "1" });
    expect(res.status).toBe(201);
    const started = (await res.json()) as ImportBatch;
    expect(started.total).toBe(4);
    expect(started.counts.skipped).toBe(1);
    await app.jobs.idle();

    const [b] = await json<ImportBatch[]>("/api/imports");
    expect(b.counts).toEqual({ pending: 0, done: 1, rescued: 1, gone: 0, failed: 1, skipped: 1 });
    expect(b.finishedAt).not.toBeNull();

    const failed = await json<ImportItem[]>(`/api/imports/${b.id}/items?status=failed`);
    expect(failed).toHaveLength(1);
    expect(failed[0].url).toBe(`${base}/wall`);
    expect(failed[0].error).toMatch(/403/);

    const [rescued] = await json<ImportItem[]>(`/api/imports/${b.id}/items?status=rescued`);
    const a = await json<{ sourceStatus: string; tags: string[]; content: string; snapshots: { method: string; warnings: string[] }[] }>(`/api/archives/${rescued.archiveId}`);
    expect(a.sourceStatus).toBe("gone");
    expect(a.tags).toEqual(["读书", "搬家"]);
    expect(a.snapshots[0].method).toBe("wayback");
    expect(a.snapshots[0].warnings[0]).toMatch(/Internet Archive/);
    expect(a.content).toContain(`href="${base}/other"`);
    expect(a.content).not.toContain("archive.org");

    // the link we already had only gained the tags
    const already = app.archives.byUrl(`${base}/already`)!;
    expect(JSON.parse(already.tags)).toEqual(["搬家"]);
    expect(already.snapshot_count).toBe(1);

    // failed links can be queued again
    expect((await json<{ changed: number }>(`/api/imports/${b.id}/retry`, { method: "POST", body: "{}" })).changed).toBe(1);
    await app.jobs.idle();
    expect((await json<ImportBatch[]>("/api/imports"))[0].counts.failed).toBe(1);
  });

  it("rescues an archived article whose original disappeared", { timeout: 20_000 }, async () => {
    const nowhere = await json<{ error: string }>("/api/archives", { method: "POST", body: JSON.stringify({ url: `${base}/nowhere`, wait: true }) });
    expect(nowhere.error).toBe("gone");
    const alive = app.archives.byUrl(`${base}/alive`)!;
    const none = await web.request(`/api/archives/${alive.id}/wayback`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(none.status).toBe(404); // nothing in the fake Internet Archive for this one
    const dead = app.archives.byUrl(`${base}/dead`)!;
    const r = await json<{ archiveId: number; snapshotId: number }>(`/api/archives/${dead.id}/wayback`, { method: "POST", body: "{}" });
    expect(r.archiveId).toBe(dead.id);
    expect(app.archives.snapshots(dead.id)).toHaveLength(2);
    expect(app.archives.row(dead.id)!.source_status).toBe("gone");
  });
});
