/**
 * Moving in: archive the links of an import one by one in the background. The queue is the import_items table,
 * so a half-done move-in carries on after a restart; the scheduler calls importTick every 15 s and each finished
 * link pulls in the next. A link whose original is gone is looked up in the Internet Archive when the batch asks.
 */
import type { App } from "../app.ts";
import type { ImportItemStatus } from "../../shared/types.ts";
import { batchOptions } from "../store/imports.ts";
import { GoneError, capture } from "../archive/capture.ts";
import { captureFromWayback } from "../archive/wayback.ts";
import { canonicalUrl, hostOf } from "../util/url.ts";
import { logger } from "../util/log.ts";

const log = logger("import");
// Enough to keep the queue busy; feed refreshes and the user's own captures have a higher priority anyway.
const IN_FLIGHT = 6;
const inflight = new Set<number>();

/** Queue the next few pending links. Safe to call often. */
export function importTick(app: App): void {
  const room = IN_FLIGHT - inflight.size;
  if (room <= 0) return;
  for (const row of app.imports.nextPending(room, [...inflight])) {
    inflight.add(row.id);
    const ok = app.jobs.add(
      `import:${row.id}`,
      hostOf(row.url),
      () =>
        runItem(app, row.id).finally(() => {
          inflight.delete(row.id);
          importTick(app);
        }),
      -2,
    );
    if (!ok) inflight.delete(row.id);
  }
}

/** Add tags to an archive that is already there (a link we had before the move-in). */
export function mergeTags(app: App, archiveId: number, tags: string[]): void {
  if (!tags.length) return;
  const row = app.archives.row(archiveId);
  if (!row) return;
  const cur = JSON.parse(row.tags || "[]") as string[];
  const next = [...new Set([...cur, ...tags])];
  if (next.length !== cur.length) app.archives.update(archiveId, { tags: next });
}

async function runItem(app: App, id: number): Promise<void> {
  const item = app.imports.item(id);
  if (!item || item.status !== "pending") return;
  const batch = app.imports.batch(item.import_id);
  if (!batch || batch.paused) return;
  const opts = batchOptions(batch);
  const tags = [...new Set([...(JSON.parse(item.tags || "[]") as string[]), ...opts.tags])];
  let status: ImportItemStatus = "failed";
  let archiveId: number | null = null;
  let error: string | null = null;

  const existing = app.archives.idByUrl(canonicalUrl(item.url));
  if (existing) {
    mergeTags(app, existing, tags);
    status = "skipped";
    archiveId = existing;
  } else {
    try {
      const res = await capture(app, { url: item.url, method: "fetch", tags, quiet: true });
      status = "done";
      archiveId = res.archiveId;
      // a page whose only title is its address: the old tool's title is better than nothing
      if (item.title && res.title === item.url) app.archives.update(res.archiveId, { title: item.title });
    } catch (err) {
      if (err instanceof GoneError && opts.wayback) {
        try {
          const res = await captureFromWayback(app, { url: item.url, near: item.saved_at, title: item.title || undefined, tags, quiet: true });
          if (res) {
            status = "rescued";
            archiveId = res.archiveId;
          } else {
            status = "gone";
            error = `${err.message}；Internet Archive 也没有`;
          }
        } catch (e2) {
          error = `原文已失效；Internet Archive：${(e2 as Error).message}`;
        }
      } else if (err instanceof GoneError) {
        status = "gone";
        error = err.message;
      } else {
        error = (err as Error).message;
      }
    }
  }
  if (archiveId && item.note) {
    const row = app.archives.row(archiveId);
    if (row && !row.note) app.archives.update(archiveId, { note: item.note });
  }
  app.imports.setResult(id, status, archiveId, error);
  const after = app.imports.batch(item.import_id);
  app.events.emit({ type: "import", id: item.import_id, finished: !!after?.finished_at });
  if (after?.finished_at) {
    log.info(`move-in #${after.id} finished: ${after.label}`);
    app.events.emit({ type: "counts" });
  }
}
