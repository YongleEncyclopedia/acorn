import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import { addFeed, previewSource } from "../../feeds/add.ts";
import { queueRefresh, refreshFeed } from "../../feeds/refresh.ts";
import { exportOpml, importOpml } from "../../feeds/opml.ts";
import { iconFile } from "../../feeds/icons.ts";
import { bridgeFeedUrl, listBridgeAccounts, syncWechatBridge } from "../../feeds/wechat-bridge.ts";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const KIND = z.enum(["feed", "rsshub", "html", "plugin"]);
const HTML_RULE = z.object({ item: z.string().min(1), title: z.string().optional(), link: z.string().optional(), date: z.string().optional(), summary: z.string().optional(), image: z.string().optional() });
const CONFIG = z
  .object({
    html: HTML_RULE.optional(),
    plugin: z.object({ id: z.string(), params: z.record(z.string(), z.string()).optional() }).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    cookie: z.string().optional(),
    userAgent: z.string().optional(),
    contentSelector: z.string().optional(),
  })
  .partial();

const ADD = z.object({
  input: z.string().min(1),
  kind: KIND.optional(),
  title: z.string().optional(),
  folderId: z.number().int().nullable().optional(),
  folderName: z.string().optional(),
  config: CONFIG.optional(),
  fullText: z.enum(["never", "auto", "always"]).optional(),
  autoArchive: z.boolean().optional(),
  fetchInterval: z.number().int().min(5).max(10080).nullable().optional(),
});

const PATCH = z.object({
  customTitle: z.string().nullable().optional(),
  folderId: z.number().int().nullable().optional(),
  config: CONFIG.optional(),
  fullText: z.enum(["never", "auto", "always"]).optional(),
  autoArchive: z.boolean().optional(),
  fetchInterval: z.number().int().min(5).max(10080).nullable().optional(),
  paused: z.boolean().optional(),
  url: z.string().min(1).optional(),
});

const ICON_TYPES: Record<string, string> = { png: "image/png", ico: "image/x-icon", svg: "image/svg+xml", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function registerFeeds(r: Hono, app: App): void {
  r.get("/api/feeds", (c) => c.json(app.feeds.list().map(({ etag: _e, lastModified: _l, ...f }) => f)));

  r.post("/api/feeds/preview", async (c) => {
    const body = z.object({ input: z.string().min(1), kind: KIND.optional(), config: CONFIG.optional() }).parse(await c.req.json());
    return c.json(await previewSource(app, body));
  });

  r.post("/api/feeds", async (c) => {
    const body = ADD.parse(await c.req.json());
    const res = await addFeed(app, body);
    const { etag: _e, lastModified: _l, ...feed } = res.feed;
    return c.json({ feed, existed: res.existed, added: res.added, error: res.error ?? null }, res.existed ? 200 : 201);
  });

  r.patch("/api/feeds/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = PATCH.parse(await c.req.json());
    const feed = app.feeds.update(id, body);
    if (!feed) return c.json({ error: "not_found" }, 404);
    if (body.url || body.config) queueRefresh(app, id, 10);
    app.events.emit({ type: "counts" });
    const { etag: _e, lastModified: _l, ...out } = feed;
    return c.json(out);
  });

  r.delete("/api/feeds/:id", (c) => {
    const id = Number(c.req.param("id"));
    const icon = iconFile(app, id);
    const ok = app.feeds.delete(id);
    if (icon && existsSync(icon)) unlinkSync(icon);
    app.events.emit({ type: "counts" });
    return c.json({ ok });
  });

  r.post("/api/feeds/:id/refresh", async (c) => {
    const id = Number(c.req.param("id"));
    if (c.req.query("wait")) return c.json(await refreshFeed(app, id));
    return c.json({ queued: queueRefresh(app, id, 10) });
  });

  r.post("/api/feeds/refresh", (c) => {
    let n = 0;
    for (const f of app.feeds.list()) if (!f.paused && queueRefresh(app, f.id, 5)) n += 1;
    return c.json({ queued: n });
  });

  // ---- WeChat accounts via we-mp-rss ----
  const bridgeDown = (err: unknown) => ({ error: "upstream", message: `连不上 we-mp-rss：${(err as Error).message}` });
  r.get("/api/wechat-bridge", async (c) => {
    const base = app.settings.all().wechatBridge.url;
    if (!base) return c.json({ url: "", accounts: [] });
    try {
      const accounts = await listBridgeAccounts(app, base);
      return c.json({ url: base, accounts: accounts.map((a) => ({ ...a, feedId: app.feeds.find("feed", bridgeFeedUrl(base, a.id))?.id ?? null })) });
    } catch (err) {
      return c.json(bridgeDown(err), 502);
    }
  });
  r.post("/api/wechat-bridge/sync", async (c) => {
    if (!app.settings.all().wechatBridge.url) return c.json({ error: "bad_request", message: "还没有填写 we-mp-rss 的地址" }, 400);
    try {
      return c.json(await syncWechatBridge(app));
    } catch (err) {
      return c.json(bridgeDown(err), 502);
    }
  });

  r.get("/api/feeds/:id/logs", (c) => c.json(app.feeds.logs(Number(c.req.param("id")))));

  r.get("/api/icons/:id", (c) => {
    const file = iconFile(app, Number(c.req.param("id")));
    if (!file || !existsSync(file)) return c.body(null, 404);
    const ext = file.split(".").pop() || "png";
    return new Response(readFileSync(file), {
      headers: { "content-type": ICON_TYPES[ext] || "application/octet-stream", "cache-control": "private, max-age=86400", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" },
    });
  });

  // folders
  r.post("/api/folders", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(await c.req.json());
    return c.json(app.feeds.createFolder(name), 201);
  });
  r.patch("/api/folders/:id", async (c) => {
    const body = z.object({ name: z.string().min(1).max(60).optional(), sort: z.number().int().optional() }).parse(await c.req.json());
    app.feeds.updateFolder(Number(c.req.param("id")), body);
    return c.json({ ok: true });
  });
  r.delete("/api/folders/:id", (c) => {
    app.feeds.deleteFolder(Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // OPML
  r.get("/api/opml", (c) => {
    const stamp = new Date().toISOString().slice(0, 10);
    return c.body(exportOpml(app), 200, { "content-type": "text/x-opml; charset=utf-8", "content-disposition": `attachment; filename="acorn-${stamp}.opml"` });
  });
  r.post("/api/opml", async (c) => {
    const ct = c.req.header("content-type") || "";
    let xml: string;
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const f = form.file;
      xml = typeof f === "string" ? f : await (f as File).text();
    } else xml = await c.req.text();
    const res = importOpml(app, xml);
    app.events.emit({ type: "counts" });
    return c.json(res);
  });
}
