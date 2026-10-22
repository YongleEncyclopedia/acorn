import type { Db, Param } from "../db/index.ts";
import { ftsQuery, likePattern } from "../db/index.ts";
import type { ArchiveSummary, Page, Snapshot, SourceStatus } from "../../shared/types.ts";

export interface ArchiveRow {
  id: number;
  url: string;
  entry_id: number | null;
  title: string;
  site: string | null;
  author: string | null;
  published_at: number | null;
  excerpt: string | null;
  lead_image: string | null;
  tags: string;
  note: string | null;
  dir: string;
  latest_snapshot_id: number | null;
  source_status: SourceStatus;
  source_checked_at: number | null;
  gone_at: number | null;
  created_at: number;
  updated_at: number;
  snapshot_count?: number;
  latest_captured_at?: number | null;
  bytes?: number;
  highlight_count?: number;
}

export interface SnapshotRow {
  id: number;
  archive_id: number;
  captured_at: number;
  method: Snapshot["method"];
  dir: string;
  content_hash: string;
  text_length: number;
  bytes: number;
  assets: number;
  has_mhtml: number;
  has_screenshot: number;
  status: string;
  warnings: string;
}

/** URL path under which archive files are served (see api/files). */
export function fileUrl(relPath: string): string {
  return `/files/archive/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

const SUMMARY_SQL = `select a.*,
  (select count(*) from snapshots s where s.archive_id = a.id) as snapshot_count,
  (select max(captured_at) from snapshots s where s.archive_id = a.id) as latest_captured_at,
  (select coalesce(sum(bytes), 0) from snapshots s where s.archive_id = a.id) as bytes,
  (select count(*) from highlights h where h.archive_id = a.id or (a.entry_id is not null and h.entry_id = a.entry_id)) as highlight_count
  from archives a`;

export function toArchiveSummary(r: ArchiveRow): ArchiveSummary {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags || "[]");
  } catch {
    tags = [];
  }
  return {
    id: r.id,
    url: r.url,
    entryId: r.entry_id,
    title: r.title,
    site: r.site,
    author: r.author,
    publishedAt: r.published_at,
    excerpt: r.excerpt,
    leadImage: r.lead_image ? fileUrl(r.lead_image) : null,
    tags,
    sourceStatus: r.source_status,
    sourceCheckedAt: r.source_checked_at,
    goneAt: r.gone_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    snapshotCount: r.snapshot_count ?? 0,
    latestCapturedAt: r.latest_captured_at ?? null,
    bytes: r.bytes ?? 0,
    highlightCount: r.highlight_count ?? 0,
  };
}

export function toSnapshot(r: SnapshotRow): Snapshot {
  let warnings: string[] = [];
  try {
    warnings = JSON.parse(r.warnings || "[]");
  } catch {
    warnings = [];
  }
  return {
    id: r.id,
    archiveId: r.archive_id,
    capturedAt: r.captured_at,
    method: r.method,
    bytes: r.bytes,
    assets: r.assets,
    textLength: r.text_length,
    status: r.status,
    warnings,
    files: {
      article: fileUrl(`${r.dir}/article.html`),
      markdown: fileUrl(`${r.dir}/article.md`),
      source: fileUrl(`${r.dir}/source.html`),
      mhtml: r.has_mhtml ? fileUrl(`${r.dir}/page.mhtml`) : null,
      screenshot: r.has_screenshot ? fileUrl(`${r.dir}/screenshot.png`) : null,
      folder: r.dir,
    },
  };
}

export interface NewArchive {
  url: string;
  entryId: number | null;
  title: string;
  site: string | null;
  author: string | null;
  publishedAt: number | null;
  excerpt: string | null;
  dir: string;
  tags?: string[];
}

export interface NewSnapshot {
  capturedAt: number;
  method: Snapshot["method"];
  dir: string;
  contentHash: string;
  textLength: number;
  bytes: number;
  assets: number;
  hasMhtml: boolean;
  hasScreenshot: boolean;
  status: string;
  warnings: string[];
  leadImage: string | null;
}

export interface ArchiveListQuery {
  q?: string;
  tag?: string;
  status?: SourceStatus;
  cursor?: string | null;
  limit?: number;
}

export class ArchiveStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  row(id: number): ArchiveRow | undefined {
    return this.db.get<ArchiveRow>(`${SUMMARY_SQL} where a.id = ?`, id);
  }

  byUrl(url: string): ArchiveRow | undefined {
    return this.db.get<ArchiveRow>(`${SUMMARY_SQL} where a.url = ?`, url);
  }

  /** Just the id, for checking thousands of links quickly. */
  idByUrl(url: string): number | undefined {
    return this.db.get<{ id: number }>("select id from archives where url = ?", url)?.id;
  }

  byEntry(entryId: number): ArchiveRow | undefined {
    return this.db.get<ArchiveRow>(`${SUMMARY_SQL} where a.entry_id = ? order by a.id limit 1`, entryId);
  }

  create(a: NewArchive): number {
    const now = Date.now();
    return this.db.run(
      `insert into archives (url, entry_id, title, site, author, published_at, excerpt, dir, tags, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.url,
      a.entryId,
      a.title,
      a.site,
      a.author,
      a.publishedAt,
      a.excerpt,
      a.dir,
      JSON.stringify(a.tags || []),
      now,
      now,
    ).lastInsertRowid;
  }

  addSnapshot(archiveId: number, s: NewSnapshot, meta: { title: string; site: string | null; author: string | null; publishedAt: number | null; excerpt: string | null }): number {
    return this.db.tx(() => {
      const id = this.db.run(
        `insert into snapshots (archive_id, captured_at, method, dir, content_hash, text_length, bytes, assets, has_mhtml, has_screenshot, status, warnings)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        archiveId,
        s.capturedAt,
        s.method,
        s.dir,
        s.contentHash,
        s.textLength,
        s.bytes,
        s.assets,
        s.hasMhtml ? 1 : 0,
        s.hasScreenshot ? 1 : 0,
        s.status,
        JSON.stringify(s.warnings),
      ).lastInsertRowid;
      this.db.run(
        `update archives set latest_snapshot_id = ?, updated_at = ?, title = case when ? <> '' then ? else title end,
           site = coalesce(?, site), author = coalesce(?, author), published_at = coalesce(published_at, ?), excerpt = coalesce(?, excerpt),
           lead_image = coalesce(?, lead_image) where id = ?`,
        id,
        s.capturedAt,
        meta.title,
        meta.title,
        meta.site,
        meta.author,
        meta.publishedAt,
        meta.excerpt,
        s.leadImage,
        archiveId,
      );
      return id;
    });
  }

  linkEntry(archiveId: number, entryId: number): void {
    this.db.run("update archives set entry_id = coalesce(entry_id, ?) where id = ?", entryId, archiveId);
  }

  latestSnapshot(archiveId: number): SnapshotRow | undefined {
    return this.db.get<SnapshotRow>("select * from snapshots where archive_id = ? order by captured_at desc, id desc limit 1", archiveId);
  }

  snapshots(archiveId: number): SnapshotRow[] {
    return this.db.all<SnapshotRow>("select * from snapshots where archive_id = ? order by captured_at desc, id desc", archiveId);
  }

  snapshot(id: number): SnapshotRow | undefined {
    return this.db.get<SnapshotRow>("select * from snapshots where id = ?", id);
  }

  list(q: ArchiveListQuery): Page<ArchiveSummary> {
    const limit = Math.min(Math.max(q.limit || 40, 1), 200);
    const where: string[] = [];
    const params: Param[] = [];
    if (q.q?.trim()) {
      const fts = ftsQuery(q.q);
      if (fts) {
        where.push("a.id in (select rowid from archives_fts where archives_fts match ?)");
        params.push(fts);
      } else {
        where.push("(a.title like ? escape '\\' or a.excerpt like ? escape '\\' or a.site like ? escape '\\')");
        params.push(likePattern(q.q), likePattern(q.q), likePattern(q.q));
      }
    }
    if (q.tag) {
      where.push("exists (select 1 from json_each(a.tags) t where t.value = ?)");
      params.push(q.tag);
    }
    if (q.status) {
      where.push("a.source_status = ?");
      params.push(q.status);
    }
    if (q.cursor) {
      const [k, id] = q.cursor.split(":").map(Number);
      if (Number.isFinite(k) && Number.isFinite(id)) {
        where.push("(a.created_at < ? or (a.created_at = ? and a.id < ?))");
        params.push(k, k, id);
      }
    }
    const rows = this.db.all<ArchiveRow>(
      `${SUMMARY_SQL} ${where.length ? `where ${where.join(" and ")}` : ""} order by a.created_at desc, a.id desc limit ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toArchiveSummary), nextCursor: more && last ? `${last.created_at}:${last.id}` : null };
  }

  tags(): { tag: string; count: number }[] {
    return this.db.all<{ tag: string; count: number }>(
      "select t.value as tag, count(*) as count from archives a, json_each(a.tags) t group by t.value order by count desc, tag",
    );
  }

  update(id: number, patch: { title?: string; tags?: string[]; note?: string | null }): void {
    if (patch.title !== undefined) this.db.run("update archives set title = ?, updated_at = ? where id = ?", patch.title, Date.now(), id);
    if (patch.tags !== undefined) {
      const tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
      this.db.run("update archives set tags = ?, updated_at = ? where id = ?", JSON.stringify(tags), Date.now(), id);
    }
    if (patch.note !== undefined) this.db.run("update archives set note = ?, updated_at = ? where id = ?", patch.note, Date.now(), id);
  }

  setSourceStatus(id: number, status: SourceStatus, at: number): void {
    this.db.run(
      `update archives set source_status = ?, source_checked_at = ?,
         gone_at = case when ? = 'gone' then coalesce(gone_at, ?) else null end where id = ?`,
      status,
      at,
      status,
      at,
      id,
    );
  }

  dueForRecheck(before: number, limit = 10): ArchiveRow[] {
    return this.db.all<ArchiveRow>(
      `select * from archives where source_status <> 'gone' and coalesce(source_checked_at, created_at) < ?
         order by coalesce(source_checked_at, created_at) limit ?`,
      before,
      limit,
    );
  }

  delete(id: number): string | null {
    const r = this.db.get<{ dir: string }>("select dir from archives where id = ?", id);
    if (!r) return null;
    this.db.run("delete from archives where id = ?", id);
    return r.dir;
  }

  index(id: number, title: string, body: string): void {
    this.db.run("delete from archives_fts where rowid = ?", id);
    this.db.run("insert into archives_fts (rowid, title, body) values (?, ?, ?)", id, title, body.slice(0, 400_000));
  }

  search(q: string, limit = 20): ArchiveSummary[] {
    return this.list({ q, limit }).items;
  }

  totalBytes(): number {
    return this.db.get<{ n: number }>("select coalesce(sum(bytes), 0) n from snapshots")?.n ?? 0;
  }
}
