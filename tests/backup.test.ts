/** Backups into a second data directory: the database copied online, each snapshot folder copied once. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { capture } from "../src/server/archive/capture.ts";
import { checkBackupDir, runBackup } from "../src/server/backup.ts";

process.env.ACORN_SILENT = "1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("backup", () => {
  let site: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let token = "";
  let dataDir = "";
  let backupDir = "";

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      if (req.url === "/img/a.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>备份测试 - 测试站</title></head><body><article><h1>备份测试</h1>${"<p>松鼠在秋天把橡果埋进土里，留到冬天慢慢吃，这段话用来测试备份。</p>".repeat(8)}<p><img src="/img/a.png" alt="图"></p></article></body></html>`,
      );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-backup-src-"));
    backupDir = mkdtempSync(path.join(os.tmpdir(), "acorn-backup-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
    token = ensureCliToken(app);
    web = createHttp(app);
    await capture(app, { url: `${base}/post/1`, method: "fetch" });
  });

  afterAll(() => {
    site.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("backs up into a second data directory, copying each snapshot once", async () => {
    expect(checkBackupDir(app, path.join(dataDir, "backup"))).toMatch(/数据目录/);
    expect(checkBackupDir(app, path.dirname(dataDir))).toMatch(/数据目录/);
    const first = await runBackup(app, backupDir);
    expect(first.error).toBeNull();
    expect(first).toMatchObject({ ok: true, snapshots: 1, copied: 1 });
    const db = new DatabaseSync(path.join(backupDir, "acorn.db"));
    expect((db.prepare("select count(*) as n from archives").get() as { n: number }).n).toBe(1);
    db.close();
    const snap = app.archives.latestSnapshot(1)!;
    expect(existsSync(path.join(backupDir, "archive", snap.dir, "meta.json"))).toBe(true);
    expect(existsSync(path.join(backupDir, "archive", snap.dir, "assets"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(backupDir, "backup.json"), "utf8")).copied).toBe(1);

    const again = await runBackup(app, backupDir);
    expect(again).toMatchObject({ ok: true, snapshots: 1, copied: 0 });
    await capture(app, { url: `${base}/post/2`, method: "fetch" });
    const third = await runBackup(app, backupDir);
    expect(third).toMatchObject({ ok: true, snapshots: 2, copied: 1 });

    const status = (await (await web.request("/api/backup", { headers: { authorization: `Bearer ${token}` } })).json()) as { last: { copied: number } };
    expect(status.last.copied).toBe(1);
    const bad = await web.request("/api/backup", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ dir: path.join(dataDir, "x") }),
    });
    expect(bad.status).toBe(400);
  });
});
