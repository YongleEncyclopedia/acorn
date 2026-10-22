/** Taking the library away: the export endpoint, as a Markdown pack and as a full copy of the data directory. */
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
import { readZip } from "./helpers/zip.ts";

process.env.ACORN_SILENT = "1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("export", () => {
  let site: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let token = "";
  let dataDir = "";

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      if (req.url === "/img/a.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>导出测试 - 测试站</title></head><body><article><h1>导出测试</h1>${"<p>松鼠在秋天把橡果埋进土里，留到冬天慢慢吃，这段话用来测试导出。</p>".repeat(8)}<p><img src="/img/a.png" alt="图"></p></article></body></html>`,
      );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-export-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
    token = ensureCliToken(app);
    web = createHttp(app);
    const r = await capture(app, { url: `${base}/post/1`, method: "fetch" });
    app.highlights.create({ archiveId: r.archiveId, entryId: null, quote: "松鼠在秋天把橡果埋进土里", note: "记住这句" });
  });

  afterAll(() => {
    site.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const download = async (p: string) => {
    const res = await web.request(p, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    return readZip(Buffer.from(await res.arrayBuffer()));
  };

  it("exports a Markdown pack: articles with their images beside them, notes, OPML", async () => {
    const files = await download("/api/export");
    const names = [...files.keys()];
    const md = names.find((n) => /^articles\/\d{4}\/\d{2}\/[^/]+\.md$/.test(n))!;
    expect(md).toBeDefined();
    const leaf = path.posix.basename(md, ".md");
    const text = files.get(md)!.toString("utf8");
    expect(text).toMatch(/^# 导出测试/);
    expect(text).toContain(`](${leaf}/assets/`);
    expect(names.some((n) => n.startsWith("articles/") && n.includes(`/${leaf}/assets/`) && n.endsWith(".png"))).toBe(true);
    expect(files.get(`notes/${leaf}.md`)!.toString("utf8")).toContain("> 松鼠在秋天把橡果埋进土里\n\n记住这句");
    expect(files.get("subscriptions.opml")!.toString("utf8")).toContain("<opml");
    expect(files.get("README.txt")!.toString("utf8")).toContain("articles/");
    expect(names.some((n) => n.endsWith("source.html") || n === "acorn.db")).toBe(false);
  });

  it("exports a full copy that is a data directory", async () => {
    const files = await download("/api/export?full=1");
    const names = [...files.keys()];
    expect(names).toContain("acorn.db");
    expect(names.some((n) => /^archive\/\d{4}\/\d{2}\/[^/]+\/\d{8}-\d{6}\/source\.html$/.test(n))).toBe(true);
    expect(names.some((n) => /^archive\/.*\/article\.html$/.test(n))).toBe(true);
    expect(files.get("acorn.db")!.subarray(0, 15).toString()).toBe("SQLite format 3");
  });
});
