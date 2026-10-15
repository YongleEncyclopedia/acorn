import type { Db, Param } from "../db/index.ts";
import type { Feed, FeedConfig, FeedKind, Folder, FullTextMode, FetchLogItem } from "../../shared/types.ts";

interface FeedRow {
  id: number;
  kind: FeedKind;
  url: string;
  title: string;
  custom_title: string | null;
  site_url: string | null;
  description: string | null;
  has_icon: number;
  folder_id: number | null;
  config: string;
  full_text: FullTextMode;
  auto_archive: number;
  fetch_interval: number | null;
  paused: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  last_success_at: number | null;
  next_fetch_at: number;
  error_count: number;
  last_error: string | null;
  created_at: number;
  unread?: number;
  total?: number;
}

export interface FeedInternal extends Feed {
  etag: string | null;
  lastModified: string | null;
}

function toFeed(r: FeedRow): FeedInternal {
  let config: FeedConfig = {};
  try {
    config = JSON.parse(r.config || "{}");
  } catch {
    config = {};
  }
  const fallback = r.kind === "rsshub" ? r.url : r.site_url || r.url;
  return {
    id: r.id,
    kind: r.kind,
    url: r.url,
    title: r.custom_title || r.title || fallback,
    originalTitle: r.title,
    customTitle: r.custom_title,
    siteUrl: r.site_url,
    description: r.description,
    hasIcon: !!r.has_icon,
    folderId: r.folder_id,
    config,
    fullText: r.full_text,
    autoArchive: !!r.auto_archive,
    fetchInterval: r.fetch_interval,
    paused: !!r.paused,
    lastFetchedAt: r.last_fetched_at,
    lastSuccessAt: r.last_success_at,
    nextFetchAt: r.next_fetch_at,
    errorCount: r.error_count,
    lastError: r.last_error,
    unread: r.unread ?? 0,
    total: r.total ?? 0,
    createdAt: r.created_at,
    etag: r.etag,
    lastModified: r.last_modified,
  };
}

export interface NewFeed {
  kind: FeedKind;
  url: string;
  title?: string;
  customTitle?: string | null;
  siteUrl?: string | null;
  description?: string | null;
  folderId?: number | null;
  config?: FeedConfig;
  fullText?: FullTextMode;
  autoArchive?: boolean;
  fetchInterval?: number | null;
}

export type FeedPatch = Partial<{
  customTitle: string | null;
  folderId: number | null;
  config: FeedConfig;
  fullText: FullTextMode;
  autoArchive: boolean;
  fetchInterval: number | null;
  paused: boolean;
  url: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  hasIcon: boolean;
}>;

const COUNTS_SQL = `
  select f.*,
    coalesce(u.n, 0) as unread,
    coalesce(t.n, 0) as total
  from feeds f
  left join (select feed_id, count(*) n from entries where read_at is null group by feed_id) u on u.feed_id = f.id
  left join (select feed_id, count(*) n from entries group by feed_id) t on t.feed_id = f.id`;

export class FeedStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): FeedInternal[] {
    return this.db.all<FeedRow>(`${COUNTS_SQL} order by lower(coalesce(f.custom_title, f.title, f.url))`).map(toFeed);
  }

  get(id: number): FeedInternal | undefined {
    const r = this.db.get<FeedRow>(`${COUNTS_SQL} where f.id = ?`, id);
    return r ? toFeed(r) : undefined;
  }

  find(kind: FeedKind, url: string): FeedInternal | undefined {
    const r = this.db.get<FeedRow>(`${COUNTS_SQL} where f.kind = ? and f.url = ?`, kind, url);
    return r ? toFeed(r) : undefined;
  }

  create(input: NewFeed): FeedInternal {
    const r = this.db.run(
      `insert into feeds (kind, url, title, custom_title, site_url, description, folder_id, config, full_text, auto_archive, fetch_interval, next_fetch_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      input.kind,
      input.url,
      input.title || "",
      input.customTitle || null,
      input.siteUrl || null,
      input.description || null,
      input.folderId ?? null,
      JSON.stringify(input.config || {}),
      input.fullText || (input.kind === "html" ? "always" : "auto"),
      input.autoArchive ? 1 : 0,
      input.fetchInterval ?? null,
    );
    return this.get(r.lastInsertRowid)!;
  }

  update(id: number, patch: FeedPatch): FeedInternal | undefined {
    const cols: string[] = [];
    const vals: Param[] = [];
    const set = (col: string, v: Param) => {
      cols.push(`${col} = ?`);
      vals.push(v);
    };
    if ("customTitle" in patch) set("custom_title", patch.customTitle?.trim() || null);
    if ("folderId" in patch) set("folder_id", patch.folderId ?? null);
    if ("config" in patch) set("config", JSON.stringify(patch.config || {}));
    if ("fullText" in patch) set("full_text", patch.fullText!);
    if ("autoArchive" in patch) set("auto_archive", patch.autoArchive ? 1 : 0);
    if ("fetchInterval" in patch) set("fetch_interval", patch.fetchInterval ?? null);
    if ("paused" in patch) set("paused", patch.paused ? 1 : 0);
    if ("url" in patch) {
      set("url", patch.url!);
      set("etag", null);
      set("last_modified", null);
      set("next_fetch_at", 0);
    }
    if ("title" in patch) set("title", patch.title || "");
    if ("siteUrl" in patch) set("site_url", patch.siteUrl ?? null);
    if ("description" in patch) set("description", patch.description ?? null);
    if ("hasIcon" in patch) set("has_icon", patch.hasIcon ? 1 : 0);
    if (cols.length) this.db.run(`update feeds set ${cols.join(", ")} where id = ?`, ...vals, id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.run("delete from feeds where id = ?", id).changes > 0;
  }

  due(now: number, limit = 20): FeedInternal[] {
    return this.db
      .all<FeedRow>(`select * from feeds where paused = 0 and next_fetch_at <= ? order by next_fetch_at limit ?`, now, limit)
      .map(toFeed);
  }

  recordSuccess(id: number, at: number, nextAt: number, etag: string | null, lastModified: string | null): void {
    this.db.run(
      `update feeds set last_fetched_at = ?, last_success_at = ?, next_fetch_at = ?, error_count = 0, last_error = null,
        etag = coalesce(?, etag), last_modified = coalesce(?, last_modified) where id = ?`,
      at,
      at,
      nextAt,
      etag,
      lastModified,
      id,
    );
  }

  recordError(id: number, at: number, nextAt: number, error: string): void {
    this.db.run(
      `update feeds set last_fetched_at = ?, next_fetch_at = ?, error_count = error_count + 1, last_error = ? where id = ?`,
      at,
      nextAt,
      error.slice(0, 500),
      id,
    );
  }

  scheduleNow(id: number): void {
    this.db.run("update feeds set next_fetch_at = 0 where id = ?", id);
  }

  log(feedId: number, item: FetchLogItem): void {
    this.db.run(
      "insert into fetch_log (feed_id, at, status, added, ms, error) values (?, ?, ?, ?, ?, ?)",
      feedId,
      item.at,
      item.status,
      item.added,
      item.ms,
      item.error,
    );
    this.db.run(
      "delete from fetch_log where feed_id = ? and id not in (select id from fetch_log where feed_id = ? order by at desc limit 40)",
      feedId,
      feedId,
    );
  }

  logs(feedId: number): FetchLogItem[] {
    return this.db.all<FetchLogItem>(
      "select at, status, added, ms, error from fetch_log where feed_id = ? order by at desc limit 40",
      feedId,
    );
  }

  // ---- folders ----
  folders(): Folder[] {
    return this.db.all<Folder>("select id, name, sort from folders order by sort, name");
  }

  folderByName(name: string): Folder | undefined {
    return this.db.get<Folder>("select id, name, sort from folders where name = ?", name);
  }

  createFolder(name: string): Folder {
    const existing = this.folderByName(name.trim());
    if (existing) return existing;
    const max = this.db.get<{ m: number | null }>("select max(sort) m from folders")?.m ?? 0;
    const r = this.db.run("insert into folders (name, sort) values (?, ?)", name.trim(), (max || 0) + 1);
    return { id: r.lastInsertRowid, name: name.trim(), sort: (max || 0) + 1 };
  }

  updateFolder(id: number, patch: { name?: string; sort?: number }): void {
    if (patch.name !== undefined) this.db.run("update folders set name = ? where id = ?", patch.name.trim(), id);
    if (patch.sort !== undefined) this.db.run("update folders set sort = ? where id = ?", patch.sort, id);
  }

  deleteFolder(id: number): void {
    this.db.run("delete from folders where id = ?", id);
  }
}
