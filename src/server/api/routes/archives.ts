import type { Hono } from "hono";
import { z } from "zod";
import { readFileSync, existsSync, statSync, rmSync, mkdirSync, writeFileSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import type { App } from "../../app.ts";
import type { ArchiveDetail, HighlightColor } from "../../../shared/types.ts";
import { toArchiveSummary, toSnapshot, fileUrl } from "../../store/archives.ts";
import { capture, queueCapture, resumeCapture } from "../../archive/capture.ts";
import { dropPending, listPending, registerPending } from "../../archive/browser.ts";
import { recheckArchive } from "../../archive/recheck.ts";
import { archiveHtml } from "../content.ts";
import { httpGet } from "../../util/http.ts";
import { sha1 } from "../../util/text.ts";
import { originOf } from "../../util/url.ts";
import { ruleFor } from "../../content/rules/index.ts";
import { sniffImage } from "../../archive/assets.ts";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  mhtml: "multipart/related",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
const INLINE = new Set(["html", "md", "json", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "pdf", "txt", "csv"]);

export function archiveDetail(app: App, id: number, snapshotId?: number): ArchiveDetail | null {
  const row = app.archives.row(id);
  if (!row) return null;
  const snaps = app.archives.snapshots(id);
  const snap = (snapshotId && snaps.find((s) => s.id === snapshotId)) || snaps[0];
  let content = "";
  if (snap) {
    const file = path.join(app.cfg.archiveDir, snap.dir, "content.html");
    if (existsSync(file)) content = archiveHtml(readFileSync(file, "utf8"), fileUrl(snap.dir), row.url);
  }
  return {
    ...toArchiveSummary(row),
    content,
    note: row.note,
    snapshots: snaps.map(toSnapshot),
    highlights: app.highlights.forArchive(id),
    absolutePath: path.join(app.cfg.archiveDir, row.dir),
  };
}

export function registerArchives(r: Hono, app: App): void {
  r.get("/api/archives", (c) => {
    const q = c.req.query();
    const status = q.status === "gone" || q.status === "changed" || q.status === "alive" || q.status === "unknown" ? q.status : undefined;
    return c.json(app.archives.list({ q: q.q, tag: q.tag, status, cursor: q.cursor || null, limit: q.limit ? Number(q.limit) : 40 }));
  });

  r.get("/api/archives/tags", (c) => c.json(app.archives.tags()));

  // Browser captures waiting for the user to pass a captcha / login in the handed-off ego-browser page.
  r.get("/api/archives/pending", (c) => c.json(listPending()));
  r.post("/api/archives/resume", async (c) => {
    const { spaceId } = z.object({ spaceId: z.number().int() }).parse(await c.req.json());
    const res = await resumeCapture(app, spaceId);
    app.events.emit({ type: "counts" });
    return c.json(res);
  });
  /** Archive the page that is already open in an ego-browser space (e.g. an article you verified by hand). */
  r.post("/api/archives/from-browser", async (c) => {
    const body = z.object({ spaceId: z.number().int(), url: z.string().url().optional(), tags: z.array(z.string()).optional() }).parse(await c.req.json());
    registerPending({ spaceId: body.spaceId, url: body.url || "", entryId: null, tags: body.tags, reason: "已在浏览器中打开", createdAt: Date.now() });
    const res = await resumeCapture(app, body.spaceId);
    app.events.emit({ type: "counts" });
    return c.json(res);
  });
  r.delete("/api/archives/pending/:spaceId", (c) => c.json({ ok: dropPending(Number(c.req.param("spaceId"))) }));

  r.get("/api/archives/:id", (c) => {
    const d = archiveDetail(app, Number(c.req.param("id")), c.req.query("snapshot") ? Number(c.req.query("snapshot")) : undefined);
    return d ? c.json(d) : c.json({ error: "not_found" }, 404);
  });

  r.post("/api/archives", async (c) => {
    const body = z
      .object({
        url: z.string().url().optional(),
        entryId: z.number().int().optional(),
        method: z.enum(["fetch", "browser"]).default("fetch"),
        tags: z.array(z.string()).optional(),
        title: z.string().optional(),
        wait: z.boolean().optional(),
      })
      .parse(await c.req.json());
    let url = body.url;
    if (!url && body.entryId) url = app.entries.row(body.entryId)?.url || undefined;
    if (!url) return c.json({ error: "bad_request", message: "需要 url 或 entryId" }, 400);
    if (body.wait || c.req.query("wait")) {
      if (body.method === "browser") {
        const { browserCapture } = await import("../../archive/browser.ts");
        const shot = await browserCapture(app, url, { entryId: body.entryId, tags: body.tags, title: body.title });
        const res = await capture(app, { url, entryId: body.entryId, method: "browser", html: shot.html, finalUrl: shot.finalUrl, mhtml: shot.mhtml, screenshot: shot.screenshot, tags: body.tags, title: body.title, force: true });
        return c.json(res);
      }
      return c.json(await capture(app, { url, entryId: body.entryId, method: "fetch", tags: body.tags, title: body.title }));
    }
    return c.json({ queued: queueCapture(app, { url, entryId: body.entryId, method: body.method, tags: body.tags, title: body.title }) }, 202);
  });

  /** Import a page you saved yourself: multipart fields url, title, tags, html (text or file), mhtml (file), screenshot (file). */
  r.post("/api/archives/import", async (c) => {
    const form = await c.req.parseBody();
    const asBuffer = async (v: unknown) => (v && typeof v !== "string" ? Buffer.from(await (v as File).arrayBuffer()) : null);
    const mhtml = await asBuffer(form.mhtml);
    const htmlField = form.html;
    const html = typeof htmlField === "string" ? htmlField : htmlField ? await (htmlField as File).text() : null;
    let url = typeof form.url === "string" ? form.url : "";
    if (!url && mhtml) url = mhtml.toString("latin1").match(/Snapshot-Content-Location:\s*(\S+)/i)?.[1] || "";
    if (!url) return c.json({ error: "bad_request", message: "缺少 url" }, 400);
    const tags = typeof form.tags === "string" ? form.tags.split(/[,，\s]+/).filter(Boolean) : undefined;
    const res = await capture(app, {
      url,
      method: "import",
      html,
      mhtml,
      screenshot: await asBuffer(form.screenshot),
      title: typeof form.title === "string" ? form.title : undefined,
      tags,
      force: true,
    });
    return c.json(res);
  });

  r.post("/api/archives/:id/snapshot", async (c) => {
    const id = Number(c.req.param("id"));
    const a = app.archives.row(id);
    if (!a) return c.json({ error: "not_found" }, 404);
    const { method } = z.object({ method: z.enum(["fetch", "browser"]).default("fetch") }).parse(await c.req.json().catch(() => ({})));
    return c.json({ queued: queueCapture(app, { url: a.url, entryId: a.entry_id, method, force: true }) }, 202);
  });

  r.post("/api/archives/:id/recheck", async (c) => c.json(await recheckArchive(app, Number(c.req.param("id")))));

  r.patch("/api/archives/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = z.object({ title: z.string().min(1).optional(), tags: z.array(z.string()).optional(), note: z.string().nullable().optional() }).parse(await c.req.json());
    app.archives.update(id, body);
    const d = archiveDetail(app, id);
    return d ? c.json(d) : c.json({ error: "not_found" }, 404);
  });

  r.delete("/api/archives/:id", (c) => {
    const dir = app.archives.delete(Number(c.req.param("id")));
    if (dir) {
      const abs = path.resolve(app.cfg.archiveDir, dir);
      if (abs.startsWith(app.cfg.archiveDir + path.sep)) rmSync(abs, { recursive: true, force: true });
    }
    app.events.emit({ type: "counts" });
    return c.json({ ok: !!dir });
  });

  // ---- highlights & notes ----
  const COLOR = z.enum(["amber", "green", "blue", "rose", "violet"]);
  r.get("/api/highlights", (c) => c.json(app.highlights.list({ q: c.req.query("q"), cursor: c.req.query("cursor") || null, limit: Number(c.req.query("limit") || 50) })));
  r.post("/api/highlights", async (c) => {
    const body = z
      .object({
        entryId: z.number().int().nullable().optional(),
        archiveId: z.number().int().nullable().optional(),
        quote: z.string().min(1).max(20_000),
        prefix: z.string().max(200).optional(),
        suffix: z.string().max(200).optional(),
        note: z.string().max(20_000).nullable().optional(),
        color: COLOR.optional(),
      })
      .parse(await c.req.json());
    if (!body.entryId && !body.archiveId) return c.json({ error: "bad_request", message: "需要 entryId 或 archiveId" }, 400);
    const h = app.highlights.create({ ...body, entryId: body.entryId ?? null, archiveId: body.archiveId ?? null, color: body.color as HighlightColor | undefined });
    if (body.entryId && app.settings.all().archiveOnHighlight && !app.archives.byEntry(body.entryId)) {
      const row = app.entries.row(body.entryId);
      if (row?.url) queueCapture(app, { url: row.url, entryId: row.id, method: "fetch" });
    }
    app.events.emit({ type: "counts" });
    return c.json(h, 201);
  });
  r.patch("/api/highlights/:id", async (c) => {
    const body = z.object({ note: z.string().max(20_000).nullable().optional(), color: COLOR.optional() }).parse(await c.req.json());
    const h = app.highlights.update(Number(c.req.param("id")), body as { note?: string | null; color?: HighlightColor });
    return h ? c.json(h) : c.json({ error: "not_found" }, 404);
  });
  r.delete("/api/highlights/:id", (c) => {
    const ok = app.highlights.delete(Number(c.req.param("id")));
    app.events.emit({ type: "counts" });
    return c.json({ ok });
  });

  // ---- archive files (auth required; scripts disabled) ----
  r.get("/files/archive/*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path.slice("/files/archive/".length));
    } catch {
      return c.body(null, 400);
    }
    const abs = path.resolve(app.cfg.archiveDir, rel);
    if (!abs.startsWith(app.cfg.archiveDir + path.sep) || !existsSync(abs) || statSync(abs).isDirectory()) return c.body(null, 404);
    const ext = abs.split(".").pop()!.toLowerCase();
    const headers: Record<string, string> = {
      "content-type": MIME[ext] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
      "content-security-policy": "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    };
    if (!INLINE.has(ext)) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
    if (c.req.query("download")) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(path.dirname(abs)) + "-" + path.basename(abs))}`;
    headers["content-length"] = String(statSync(abs).size);
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers });
  });

  // ---- image proxy with disk cache ----
  r.get("/api/img", async (c) => {
    const u = c.req.query("u") || "";
    const ref = c.req.query("r") || null;
    if (!/^https?:\/\//i.test(u)) return c.body(null, 400);
    const key = sha1(u);
    const dir = path.join(app.cfg.cacheDir, "img", key.slice(0, 2));
    const bin = path.join(dir, key);
    const headers = (type: string) => ({
      "content-type": type,
      "cache-control": "private, max-age=2592000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    });
    if (existsSync(bin) && existsSync(`${bin}.type`)) {
      return new Response(readFileSync(bin), { headers: headers(readFileSync(`${bin}.type`, "utf8")) });
    }
    const rule = ref ? ruleFor(ref) : ruleFor(u);
    const referers = [...new Set([rule?.imageReferer ? rule.imageReferer(ref || u) : ref ? `${originOf(ref)}/` : null, null])];
    for (const referer of referers) {
      try {
        const res = await httpGet(u, { userAgent: app.cfg.pageUserAgent, referer, accept: "image/avif,image/webp,image/*,*/*;q=0.8", maxBytes: 25 * 1024 * 1024, timeoutMs: 25_000 });
        if (!res.ok) continue;
        const declared = res.contentType.split(";")[0].trim().toLowerCase();
        const type = sniffImage(res.body) || (declared.startsWith("image/") ? declared : null);
        if (!type) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(bin, res.body);
        writeFileSync(`${bin}.type`, type);
        return new Response(new Uint8Array(res.body), { headers: headers(type) });
      } catch {
        /* next */
      }
    }
    return c.body(null, 502);
  });
}
