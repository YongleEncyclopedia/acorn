import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { App } from "../../app.ts";
import { counts } from "../../app.ts";
import { VERSION } from "../../config.ts";
import type { Bootstrap, SearchResults, Stats } from "../../../shared/types.ts";
import { listPlugins } from "../../feeds/plugins.ts";
import { egoAvailable } from "../../archive/browser.ts";
import { sendDigest, telegramConfigured, buildDigest } from "../../notify/telegram.ts";
import { recentLogs } from "../../util/log.ts";
import { setPassword, verifyPassword } from "../auth.ts";
import { publicSettings } from "../../store/settings.ts";

export interface Hooks {
  onSettingsChanged?: () => void;
}

let sizeCache: { at: number; archive: number; cache: number } | null = null;
function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) total += statSync(p).size;
    }
  }
  return total;
}

export function registerCore(r: Hono, app: App, hooks: Hooks = {}): void {
  r.get("/api/bootstrap", async (c) => {
    const body: Bootstrap = {
      version: VERSION,
      folders: app.feeds.folders(),
      feeds: app.feeds.list().map(({ etag: _e, lastModified: _l, ...f }) => f),
      counts: counts(app),
      settings: publicSettings(app.settings.all()),
      plugins: await listPlugins(app.cfg.pluginsDir),
      egoBrowser: await egoAvailable(app),
      telegram: telegramConfigured(app),
      dataDir: app.cfg.dataDir,
    };
    return c.json(body);
  });

  r.get("/api/counts", (c) => c.json(counts(app)));

  r.get("/api/settings", (c) => c.json(publicSettings(app.settings.all())));
  r.patch("/api/settings", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const next = app.settings.update(body);
    hooks.onSettingsChanged?.();
    return c.json(publicSettings(next));
  });

  r.post("/api/password", async (c) => {
    const body = z.object({ current: z.string(), next: z.string().min(6) }).parse(await c.req.json());
    if (!verifyPassword(body.current, app.settings.getRaw("_password"))) return c.json({ error: "forbidden", message: "当前密码不正确" }, 403);
    setPassword(app, body.next);
    return c.json({ ok: true });
  });

  r.get("/api/tokens", (c) => c.json(app.tokens.list()));
  r.post("/api/tokens", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(await c.req.json());
    return c.json(app.tokens.create(name), 201);
  });
  r.delete("/api/tokens/:id", (c) => c.json({ ok: app.tokens.delete(Number(c.req.param("id"))) }));

  r.get("/api/search", (c) => {
    const q = (c.req.query("q") || "").trim();
    const body: SearchResults = q
      ? { query: q, entries: app.entries.search(q, 30), archives: app.archives.search(q, 20), highlights: app.highlights.list({ q, limit: 20 }).items }
      : { query: q, entries: [], archives: [], highlights: [] };
    return c.json(body);
  });

  r.get("/api/stats", (c) => {
    if (!sizeCache || Date.now() - sizeCache.at > 300_000) sizeCache = { at: Date.now(), archive: dirBytes(app.cfg.archiveDir), cache: dirBytes(app.cfg.cacheDir) };
    const one = (sql: string) => app.db.get<{ n: number }>(sql)?.n ?? 0;
    const body: Stats = {
      entries: one("select count(*) n from entries"),
      archives: one("select count(*) n from archives"),
      snapshots: one("select count(*) n from snapshots"),
      archiveBytes: sizeCache.archive,
      cacheBytes: sizeCache.cache,
      dbBytes: existsSync(app.cfg.dbPath) ? statSync(app.cfg.dbPath).size : 0,
      highlights: one("select count(*) n from highlights"),
      feeds: one("select count(*) n from feeds"),
      oldestEntry: app.db.get<{ n: number | null }>("select min(sort_at) n from entries")?.n ?? null,
    };
    return c.json({ ...body, jobs: app.jobs.size });
  });

  r.get("/api/logs", (c) => c.json(recentLogs(Number(c.req.query("limit") || 300))));

  r.get("/api/digest/preview", (c) => c.json({ html: buildDigest(app), configured: telegramConfigured(app) }));
  r.post("/api/digest/send", async (c) => {
    await sendDigest(app);
    return c.json({ ok: true });
  });

  r.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const off = app.events.on((ev) => {
        if (open) stream.writeSSE({ data: JSON.stringify(ev), event: "message" }).catch(() => undefined);
      });
      stream.onAbort(() => {
        open = false;
        off();
      });
      await stream.writeSSE({ data: JSON.stringify({ type: "hello", at: Date.now() }) });
      while (open) {
        await stream.sleep(20_000);
        if (open) await stream.writeSSE({ data: "", event: "ping" }).catch(() => (open = false));
      }
    }),
  );
}
