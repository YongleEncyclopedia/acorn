import type { Hono } from "hono";
import { Readable } from "node:stream";
import { z } from "zod";
import type { App } from "../../app.ts";
import { exportStream } from "../../export.ts";
import { backupStatus, checkBackupDir, runBackup } from "../../backup.ts";

/** Taking the library away (export) and keeping a second copy of it (backup). */
export function registerData(r: Hono, app: App): void {
  r.get("/api/export", (c) => {
    const full = c.req.query("full") === "1";
    const name = `acorn-${full ? "full" : "markdown"}-${new Date().toISOString().slice(0, 10)}.zip`;
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="${name}"`);
    c.header("cache-control", "no-store");
    return c.body(Readable.toWeb(exportStream(app, { full })) as ReadableStream);
  });

  r.get("/api/backup", (c) => c.json(backupStatus(app)));
  r.post("/api/backup", async (c) => {
    const body = z.object({ dir: z.string().optional(), wait: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const dir = body.dir ?? app.settings.all().backup.dir;
    const bad = checkBackupDir(app, dir);
    if (bad) return c.json({ error: "bad_request", message: bad }, 400);
    const run = runBackup(app, dir);
    if (body.wait || c.req.query("wait")) return c.json(await run);
    return c.json(backupStatus(app), 202);
  });
}
