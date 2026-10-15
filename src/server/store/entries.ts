import type { Db, Param } from "../db/index.ts";
import { ftsQuery, likePattern } from "../db/index.ts";
import type { EntrySummary, EntryView, Page } from "../../shared/types.ts";
import { htmlToText, sha1 } from "../util/text.ts";

export interface IncomingItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  /** Sanitized HTML. */
  content: string | null;
  summary: string | null;
  image: string | null;
  publishedAt: number | null;
  wordCount: number;
}

export interface EntryRow {
  id: number;
  feed_id: number;
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  full_content: string | null;
  full_fetched_at: number | null;
  full_error: string | null;
  image: string | null;
  published_at: number | null;
  created_at: number;
  read_at: number | null;
  starred_at: number | null;
  progress: number;
  progress_at: number | null;
  word_count: number;
  content_hash: string | null;
  sort_at: number;
  archive_id?: number | null;
  highlight_count?: number;
}

export interface ListQuery {
  view?: EntryView;
  feedId?: number;
  folderId?: number;
  unreadOnly?: boolean;
  cursor?: string | null;
  limit?: number;
  order?: "new" | "old";
  q?: string;
}

export interface MarkFilter {
  ids?: number[];
  view?: EntryView;
  feedId?: number;
  folderId?: number;
  before?: number;
}

const SUMMARY_COLS = `e.id, e.feed_id, e.guid, e.url, e.title, e.author, e.summary, e.image, e.published_at, e.created_at,
  e.read_at, e.starred_at, e.progress, e.progress_at, e.word_count, e.sort_at,
  (select a.id from archives a where a.entry_id = e.id order by a.id limit 1) as archive_id,
  (select count(*) from highlights h where h.entry_id = e.id) as highlight_count`;

export function toSummary(r: EntryRow): EntrySummary {
  return {
    id: r.id,
    feedId: r.feed_id,
    title: r.title,
    url: r.url,
    author: r.author,
    summary: r.summary,
    image: r.image,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    readAt: r.read_at,
    starredAt: r.starred_at,
    progress: r.progress,
    wordCount: r.word_count,
    archiveId: r.archive_id ?? null,
    highlightCount: r.highlight_count ?? 0,
  };
}

const DAY = 86_400_000;

function viewSort(view: EntryView | undefined): { expr: string; join: string } {
  switch (view) {
    case "starred":
      return { expr: "e.starred_at", join: "" };
    case "progress":
      return { expr: "coalesce(e.progress_at, e.sort_at)", join: "" };
    case "archived":
      return { expr: "ax.created_at", join: "join (select entry_id, min(created_at) created_at from archives where entry_id is not null group by entry_id) ax on ax.entry_id = e.id" };
    default:
      return { expr: "e.sort_at", join: "" };
  }
}

export class EntryStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Insert new items, refresh changed ones (keeping read/star state).
   * `grown` lists existing entries whose body arrived later (a teaser replaced by the full text).
   */
  upsert(feedId: number, items: IncomingItem[]): { added: number[]; grown: number[] } {
    const added: number[] = [];
    const grown: number[] = [];
    this.db.tx(() => {
      for (const it of items) {
        const hash = sha1(`${it.title}\n${it.content || ""}\n${it.url || ""}`);
        const existing = this.db.get<{ id: number; content_hash: string | null; full_content: string | null; word_count: number }>(
          "select id, content_hash, full_content, word_count from entries where feed_id = ? and guid = ?",
          feedId,
          it.guid,
        );
        if (!existing) {
          const r = this.db.run(
            `insert into entries (feed_id, guid, url, title, author, summary, content, image, published_at, word_count, content_hash, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            feedId,
            it.guid,
            it.url,
            it.title,
            it.author,
            it.summary,
            it.content,
            it.image,
            it.publishedAt,
            it.wordCount,
            hash,
            Date.now(),
          );
          added.push(r.lastInsertRowid);
          this.index(r.lastInsertRowid, it.title, htmlToText(it.content) || it.summary || "");
        } else if (existing.content_hash !== hash) {
          this.db.run(
            `update entries set url = ?, title = ?, author = ?, summary = ?, content = ?, image = coalesce(?, image),
               published_at = coalesce(?, published_at), word_count = max(word_count, ?), content_hash = ? where id = ?`,
            it.url,
            it.title,
            it.author,
            it.summary,
            it.content,
            it.image,
            it.publishedAt,
            it.wordCount,
            hash,
            existing.id,
          );
          if (!existing.full_content) this.index(existing.id, it.title, htmlToText(it.content) || it.summary || "");
          if (it.wordCount >= 200 && it.wordCount > existing.word_count * 2) grown.push(existing.id);
        }
      }
    });
    return { added, grown };
  }

  index(id: number, title: string, body: string): void {
    this.db.run("delete from entries_fts where rowid = ?", id);
    this.db.run("insert into entries_fts (rowid, title, body) values (?, ?, ?)", id, title, body.slice(0, 200_000));
  }

  row(id: number): EntryRow | undefined {
    return this.db.get<EntryRow>(
      `select e.*, (select a.id from archives a where a.entry_id = e.id order by a.id limit 1) as archive_id,
         (select count(*) from highlights h where h.entry_id = e.id) as highlight_count
       from entries e where e.id = ?`,
      id,
    );
  }

  byUrl(url: string): EntryRow | undefined {
    return this.db.get<EntryRow>("select * from entries where url = ? order by id desc limit 1", url);
  }

  list(q: ListQuery): Page<EntrySummary> {
    const limit = Math.min(Math.max(q.limit || 40, 1), 200);
    const { expr, join } = viewSort(q.view);
    const where: string[] = [];
    const params: Param[] = [];
    if (q.view === "unread" || q.unreadOnly) where.push("e.read_at is null");
    if (q.view === "today") {
      where.push("e.sort_at >= ?");
      params.push(Date.now() - DAY);
    }
    if (q.view === "starred") where.push("e.starred_at is not null");
    if (q.view === "progress") where.push("e.progress > 0.02 and e.progress < 0.97");
    if (q.feedId) {
      where.push("e.feed_id = ?");
      params.push(q.feedId);
    }
    if (q.folderId) {
      where.push("e.feed_id in (select id from feeds where folder_id = ?)");
      params.push(q.folderId);
    }
    if (q.q?.trim()) {
      const fts = ftsQuery(q.q);
      if (fts) {
        where.push("e.id in (select rowid from entries_fts where entries_fts match ?)");
        params.push(fts);
      } else {
        where.push("(e.title like ? escape '\\' or e.summary like ? escape '\\')");
        params.push(likePattern(q.q), likePattern(q.q));
      }
    }
    const asc = q.order === "old";
    if (q.cursor) {
      const [k, id] = q.cursor.split(":").map(Number);
      if (Number.isFinite(k) && Number.isFinite(id)) {
        where.push(asc ? `(${expr} > ? or (${expr} = ? and e.id > ?))` : `(${expr} < ? or (${expr} = ? and e.id < ?))`);
        params.push(k, k, id);
      }
    }
    const sql = `select ${SUMMARY_COLS}, ${expr} as k from entries e ${join}
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by k ${asc ? "asc" : "desc"}, e.id ${asc ? "asc" : "desc"} limit ?`;
    const rows = this.db.all<EntryRow & { k: number }>(sql, ...params, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toSummary), nextCursor: more && last ? `${last.k}:${last.id}` : null };
  }

  summaries(ids: number[]): EntrySummary[] {
    if (!ids.length) return [];
    const rows = this.db.all<EntryRow>(`select ${SUMMARY_COLS} from entries e where e.id in (${ids.map(() => "?").join(",")})`, ...ids);
    const byId = new Map(rows.map((r) => [r.id, toSummary(r)]));
    return ids.map((id) => byId.get(id)).filter((x): x is EntrySummary => !!x);
  }

  setRead(ids: number[], read: boolean): number {
    if (!ids.length) return 0;
    const ph = ids.map(() => "?").join(",");
    if (read) return this.db.run(`update entries set read_at = coalesce(read_at, ?) where id in (${ph})`, Date.now(), ...ids).changes;
    return this.db.run(`update entries set read_at = null where id in (${ph})`, ...ids).changes;
  }

  setStarred(id: number, starred: boolean): void {
    if (starred) this.db.run("update entries set starred_at = coalesce(starred_at, ?) where id = ?", Date.now(), id);
    else this.db.run("update entries set starred_at = null where id = ?", id);
  }

  setProgress(id: number, progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    this.db.run("update entries set progress = ?, progress_at = ? where id = ?", p, Date.now(), id);
    if (p >= 0.97) this.db.run("update entries set read_at = coalesce(read_at, ?) where id = ?", Date.now(), id);
  }

  setFullContent(id: number, html: string | null, error: string | null, title: string, wordCount: number): void {
    this.db.run(
      "update entries set full_content = ?, full_fetched_at = ?, full_error = ?, word_count = case when ? > word_count then ? else word_count end where id = ?",
      html,
      Date.now(),
      error,
      wordCount,
      wordCount,
      id,
    );
    if (html) this.index(id, title, htmlToText(html));
  }

  markRead(filter: MarkFilter): number {
    if (filter.ids?.length) return this.setRead(filter.ids, true);
    const where: string[] = ["read_at is null"];
    const params: Param[] = [];
    if (filter.feedId) {
      where.push("feed_id = ?");
      params.push(filter.feedId);
    }
    if (filter.folderId) {
      where.push("feed_id in (select id from feeds where folder_id = ?)");
      params.push(filter.folderId);
    }
    if (filter.view === "today") {
      where.push("sort_at >= ?");
      params.push(Date.now() - DAY);
    }
    if (filter.view === "starred") where.push("starred_at is not null");
    if (filter.before) {
      where.push("sort_at <= ?");
      params.push(filter.before);
    }
    return this.db.run(`update entries set read_at = ? where ${where.join(" and ")}`, Date.now(), ...params).changes;
  }

  /** Entries that need background work after a restart (starred but never archived, etc.). */
  starredWithoutArchive(limit = 50): EntryRow[] {
    return this.db.all<EntryRow>(
      `select e.* from entries e where e.starred_at is not null and e.url is not null
         and not exists (select 1 from archives a where a.entry_id = e.id or a.url = e.url) order by e.starred_at desc limit ?`,
      limit,
    );
  }

  search(q: string, limit = 30): EntrySummary[] {
    return this.list({ q, limit, view: "all" }).items;
  }

  /** Remove old, untouched entries (read, not starred, no archive, no highlights). */
  prune(olderThanDays: number): number {
    if (olderThanDays <= 0) return 0;
    const cutoff = Date.now() - olderThanDays * DAY;
    return this.db.run(
      `delete from entries where sort_at < ? and read_at is not null and starred_at is null
         and not exists (select 1 from archives a where a.entry_id = entries.id)
         and not exists (select 1 from highlights h where h.entry_id = entries.id)`,
      cutoff,
    ).changes;
  }
}
