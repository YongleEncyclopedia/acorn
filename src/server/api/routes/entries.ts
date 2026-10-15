import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import { counts } from "../../app.ts";
import type { Entry, EntryView } from "../../../shared/types.ts";
import { toSummary } from "../../store/entries.ts";
import { toArchiveSummary } from "../../store/archives.ts";
import { fetchFullText } from "../../content/fulltext.ts";
import { queueCapture } from "../../archive/capture.ts";
import { proxifyHtml } from "../content.ts";

const VIEWS = ["all", "unread", "today", "starred", "progress", "archived"] as const;

export function entryDetail(app: App, id: number): Entry | null {
  const row = app.entries.row(id);
  if (!row) return null;
  const archiveRow = app.archives.byEntry(id) || (row.url ? app.archives.byUrl(row.url) : undefined);
  const best = row.full_content || row.content || "";
  return {
    ...toSummary(row),
    archiveId: archiveRow?.id ?? null,
    content: proxifyHtml(best, row.url),
    feedContent: proxifyHtml(row.content || "", row.url),
    hasFullContent: !!row.full_content,
    fullFetchedAt: row.full_fetched_at,
    fullError: row.full_error,
    highlights: app.highlights.forEntry(id),
    archive: archiveRow ? toArchiveSummary(archiveRow) : null,
  };
}

export function registerEntries(r: Hono, app: App): void {
  r.get("/api/entries", (c) => {
    const q = c.req.query();
    const view = (VIEWS as readonly string[]).includes(q.view || "") ? (q.view as EntryView) : "all";
    return c.json(
      app.entries.list({
        view,
        feedId: q.feed ? Number(q.feed) : undefined,
        folderId: q.folder ? Number(q.folder) : undefined,
        unreadOnly: q.unread === "1" || q.unread === "true",
        cursor: q.cursor || null,
        limit: q.limit ? Number(q.limit) : 40,
        order: q.order === "old" ? "old" : "new",
        q: q.q,
      }),
    );
  });

  r.get("/api/entries/:id", (c) => {
    const e = entryDetail(app, Number(c.req.param("id")));
    return e ? c.json(e) : c.json({ error: "not_found" }, 404);
  });

  r.patch("/api/entries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = z.object({ read: z.boolean().optional(), starred: z.boolean().optional(), progress: z.number().min(0).max(1).optional() }).parse(await c.req.json());
    const row = app.entries.row(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (body.read !== undefined) app.entries.setRead([id], body.read);
    if (body.progress !== undefined) app.entries.setProgress(id, body.progress);
    if (body.starred !== undefined) {
      app.entries.setStarred(id, body.starred);
      if (body.starred && app.settings.all().archiveOnStar && row.url && !app.archives.byEntry(id)) {
        queueCapture(app, { url: row.url, entryId: id, method: "fetch" });
      }
    }
    if (body.read !== undefined || body.starred !== undefined) app.events.emit({ type: "counts" });
    return c.json(toSummary(app.entries.row(id)!));
  });

  r.post("/api/entries/:id/fulltext", async (c) => {
    const id = Number(c.req.param("id"));
    const res = await fetchFullText(app, id);
    const e = entryDetail(app, id);
    return c.json({ ...res, entry: e });
  });

  r.post("/api/entries/mark", async (c) => {
    const body = z
      .object({
        ids: z.array(z.number().int()).optional(),
        read: z.boolean().optional(),
        view: z.enum(VIEWS).optional(),
        feedId: z.number().int().optional(),
        folderId: z.number().int().optional(),
        before: z.number().optional(),
      })
      .parse(await c.req.json());
    const n = body.read === false && body.ids ? app.entries.setRead(body.ids, false) : app.entries.markRead(body);
    app.events.emit({ type: "counts" });
    return c.json({ changed: n, counts: counts(app) });
  });
}
