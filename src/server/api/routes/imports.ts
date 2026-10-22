import type { Context, Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import type { ImportItemStatus, ImportPreview } from "../../../shared/types.ts";
import { FORMAT_LABEL, parseImport, type ParsedImport } from "../../import/parse.ts";
import { importTick, mergeTags } from "../../import/run.ts";
import { batchOptions } from "../../store/imports.ts";
import { canonicalUrl } from "../../util/url.ts";

const MAX_FILE = 30 * 1024 * 1024;
const STATUSES = ["pending", "done", "rescued", "gone", "failed", "skipped"] as const;

/** The uploaded export (multipart `file`, or a `text` field) and the other form fields. */
async function readUpload(c: Context): Promise<{ text: string; name: string; fields: Record<string, string> } | null> {
  const form = await c.req.parseBody();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") fields[k] = v;
  const f = form.file;
  if (f && typeof f !== "string") {
    const file = f as File;
    if (file.size > MAX_FILE) throw new RangeError(`文件太大（超过 ${MAX_FILE / 1048576} MB）`);
    return { text: await file.text(), name: fields.name || file.name || "导出文件", fields };
  }
  if (fields.text?.trim()) return { text: fields.text, name: fields.name || "粘贴的链接", fields };
  return null;
}

function parsed(text: string, name: string): { p: ParsedImport; label: string } {
  const p = parseImport(text);
  return { p, label: `${FORMAT_LABEL[p.format]} · ${name}` };
}

function preview(app: App, p: ParsedImport, label: string): ImportPreview {
  const tagCount = new Map<string, number>();
  let already = 0;
  for (const l of p.links) {
    for (const t of l.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    if (app.archives.idByUrl(canonicalUrl(l.url))) already++;
  }
  return {
    format: p.format,
    label,
    total: p.links.length,
    already,
    skipped: p.skipped,
    tags: [...tagCount].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    sample: p.links.slice(0, 6).map((l) => ({ url: l.url, title: l.title, tags: l.tags, savedAt: l.savedAt })),
  };
}

export function registerImports(r: Hono, app: App): void {
  r.post("/api/imports/preview", async (c) => {
    const up = await readUpload(c);
    if (!up) return c.json({ error: "bad_request", message: "缺少文件" }, 400);
    const { p, label } = parsed(up.text, up.name);
    return c.json(preview(app, p, label));
  });

  r.post("/api/imports", async (c) => {
    const up = await readUpload(c);
    if (!up) return c.json({ error: "bad_request", message: "缺少文件" }, 400);
    const { p, label } = parsed(up.text, up.name);
    if (!p.links.length) return c.json({ error: "empty", message: "文件里没有找到网址" }, 422);
    const tags = (up.fields.tags || "").split(/[,，\s]+/).filter(Boolean);
    const wayback = !/^(0|false|off|no)$/i.test(up.fields.wayback || "1");
    const links = p.links.map((l) => ({ ...l, archiveId: app.archives.idByUrl(canonicalUrl(l.url)) ?? null }));
    const id = app.imports.create(p.format, label, { tags, wayback }, links);
    for (const l of links) if (l.archiveId) mergeTags(app, l.archiveId, [...l.tags, ...tags]);
    importTick(app);
    app.events.emit({ type: "import", id, finished: false });
    return c.json(app.imports.list().find((b) => b.id === id), 201);
  });

  r.get("/api/imports", (c) => c.json(app.imports.list()));

  r.get("/api/imports/:id/items", (c) => {
    const wanted = (c.req.query("status") || "failed,gone").split(",").filter((s): s is ImportItemStatus => (STATUSES as readonly string[]).includes(s));
    return c.json(app.imports.items(Number(c.req.param("id")), wanted.length ? wanted : ["failed"]));
  });

  r.post("/api/imports/:id/retry", async (c) => {
    const body = z.object({ statuses: z.array(z.enum(STATUSES)).optional() }).parse(await c.req.json().catch(() => ({})));
    const changed = app.imports.retry(Number(c.req.param("id")), body.statuses || ["failed"]);
    importTick(app);
    return c.json({ changed });
  });

  r.patch("/api/imports/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const b = app.imports.batch(id);
    if (!b) return c.json({ error: "not_found" }, 404);
    const body = z.object({ paused: z.boolean().optional(), tags: z.array(z.string()).optional(), wayback: z.boolean().optional() }).parse(await c.req.json());
    if (body.paused !== undefined) app.imports.setPaused(id, body.paused);
    if (body.tags !== undefined || body.wayback !== undefined) {
      const o = batchOptions(b);
      app.imports.setOptions(id, { tags: body.tags ?? o.tags, wayback: body.wayback ?? o.wayback });
    }
    if (body.paused === false) importTick(app);
    return c.json(app.imports.list().find((x) => x.id === id));
  });

  r.delete("/api/imports/:id", (c) => c.json({ ok: app.imports.delete(Number(c.req.param("id"))) }));
}
