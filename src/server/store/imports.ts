import type { Db } from "../db/index.ts";
import type { ImportBatch, ImportItem, ImportItemStatus } from "../../shared/types.ts";
import type { ImportLink } from "../import/parse.ts";

export interface ImportOptions {
  tags: string[];
  wayback: boolean;
}

interface BatchRow {
  id: number;
  source: string;
  label: string;
  options: string;
  paused: number;
  created_at: number;
  finished_at: number | null;
}

export interface ImportItemRow {
  id: number;
  import_id: number;
  url: string;
  title: string | null;
  tags: string;
  note: string | null;
  saved_at: number | null;
  status: ImportItemStatus;
  archive_id: number | null;
  error: string | null;
  attempts: number;
  updated_at: number | null;
}

const STATUSES: ImportItemStatus[] = ["pending", "done", "rescued", "gone", "failed", "skipped"];

export function batchOptions(r: { options: string }): ImportOptions {
  try {
    const o = JSON.parse(r.options || "{}");
    return { tags: Array.isArray(o.tags) ? o.tags : [], wayback: !!o.wayback };
  } catch {
    return { tags: [], wayback: false };
  }
}

export class ImportStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** A new batch; links whose URL is already archived go in as "skipped" with that archive. */
  create(source: string, label: string, options: ImportOptions, links: (ImportLink & { archiveId: number | null })[]): number {
    return this.db.tx(() => {
      const now = Date.now();
      const id = this.db.run("insert into imports (source, label, options, created_at) values (?, ?, ?, ?)", source, label, JSON.stringify(options), now).lastInsertRowid;
      for (const l of links) {
        this.db.run(
          `insert or ignore into import_items (import_id, url, title, tags, note, saved_at, status, archive_id, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          l.url,
          l.title,
          JSON.stringify(l.tags),
          l.note,
          l.savedAt,
          l.archiveId ? "skipped" : "pending",
          l.archiveId,
          now,
        );
      }
      this.finishIfDone(id);
      return id;
    });
  }

  batch(id: number): BatchRow | undefined {
    return this.db.get<BatchRow>("select * from imports where id = ?", id);
  }

  list(): ImportBatch[] {
    const rows = this.db.all<BatchRow>("select * from imports order by id desc limit 50");
    const counts = this.db.all<{ import_id: number; status: ImportItemStatus; n: number }>(
      "select import_id, status, count(*) as n from import_items group by import_id, status",
    );
    return rows.map((r) => {
      const c = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ImportItemStatus, number>;
      for (const x of counts) if (x.import_id === r.id) c[x.status] = x.n;
      const total = STATUSES.reduce((n, s) => n + c[s], 0);
      return { id: r.id, source: r.source, label: r.label, options: batchOptions(r), paused: !!r.paused, createdAt: r.created_at, finishedAt: r.finished_at, total, counts: c };
    });
  }

  items(importId: number, statuses: ImportItemStatus[], limit = 500): ImportItem[] {
    const rows = this.db.all<ImportItemRow>(
      `select * from import_items where import_id = ? and status in (${statuses.map(() => "?").join(",")}) order by updated_at desc, id limit ?`,
      importId,
      ...statuses,
      limit,
    );
    return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, status: r.status, archiveId: r.archive_id, error: r.error, savedAt: r.saved_at }));
  }

  /** The next links to archive, oldest batch first, from batches that are not paused. */
  nextPending(limit: number, exclude: number[]): ImportItemRow[] {
    return this.db.all<ImportItemRow>(
      `select i.* from import_items i join imports b on b.id = i.import_id
       where i.status = 'pending' and b.paused = 0 ${exclude.length ? `and i.id not in (${exclude.map(() => "?").join(",")})` : ""}
       order by i.import_id, i.id limit ?`,
      ...exclude,
      limit,
    );
  }

  item(id: number): ImportItemRow | undefined {
    return this.db.get<ImportItemRow>("select * from import_items where id = ?", id);
  }

  setResult(id: number, status: ImportItemStatus, archiveId: number | null, error: string | null): void {
    this.db.run(
      "update import_items set status = ?, archive_id = coalesce(?, archive_id), error = ?, attempts = attempts + 1, updated_at = ? where id = ?",
      status,
      archiveId,
      error,
      Date.now(),
      id,
    );
    const r = this.item(id);
    if (r) this.finishIfDone(r.import_id);
  }

  /** Put failed links (and, when asked, links that were already gone) back in the queue. */
  retry(importId: number, statuses: ImportItemStatus[] = ["failed"]): number {
    const n = this.db.run(
      `update import_items set status = 'pending', error = null, updated_at = ? where import_id = ? and status in (${statuses.map(() => "?").join(",")})`,
      Date.now(),
      importId,
      ...statuses,
    ).changes;
    if (n) this.db.run("update imports set finished_at = null where id = ?", importId);
    return n;
  }

  setPaused(id: number, paused: boolean): void {
    this.db.run("update imports set paused = ? where id = ?", paused ? 1 : 0, id);
  }

  setOptions(id: number, options: ImportOptions): void {
    this.db.run("update imports set options = ? where id = ?", JSON.stringify(options), id);
  }

  /** Forget a batch (its archives stay). */
  delete(id: number): boolean {
    return this.db.run("delete from imports where id = ?", id).changes > 0;
  }

  private finishIfDone(id: number): void {
    const left = this.db.get<{ n: number }>("select count(*) as n from import_items where import_id = ? and status = 'pending'", id)!.n;
    this.db.run("update imports set finished_at = case when ? = 0 then coalesce(finished_at, ?) else null end where id = ?", left, Date.now(), id);
  }
}
