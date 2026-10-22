import type { Db, Param } from "../db/index.ts";
import { ftsQuery, likePattern } from "../db/index.ts";
import type { Highlight, HighlightColor, Page } from "../../shared/types.ts";

interface HighlightRow {
  id: number;
  entry_id: number | null;
  archive_id: number | null;
  quote: string;
  prefix: string;
  suffix: string;
  note: string | null;
  color: HighlightColor;
  created_at: number;
  updated_at: number;
  title?: string | null;
  url?: string | null;
  source?: string | null;
}

function toHighlight(r: HighlightRow): Highlight {
  return {
    id: r.id,
    entryId: r.entry_id,
    archiveId: r.archive_id,
    quote: r.quote,
    prefix: r.prefix,
    suffix: r.suffix,
    note: r.note,
    color: r.color,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    title: r.title ?? undefined,
    url: r.url,
    source: r.source,
  };
}

const LIST_SQL = `select h.*,
    coalesce(e.title, a.title) as title,
    coalesce(e.url, a.url) as url,
    coalesce(f.custom_title, f.title, a.site) as source
  from highlights h
  left join entries e on e.id = h.entry_id
  left join feeds f on f.id = e.feed_id
  left join archives a on a.id = h.archive_id`;

export const COLORS: HighlightColor[] = ["amber", "green", "blue", "rose", "violet"];

export class HighlightStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  forEntry(entryId: number): Highlight[] {
    return this.db
      .all<HighlightRow>(
        `select * from highlights where entry_id = ? or archive_id in (select id from archives where entry_id = ?) order by id`,
        entryId,
        entryId,
      )
      .map(toHighlight);
  }

  forArchive(archiveId: number): Highlight[] {
    return this.db
      .all<HighlightRow>(
        `select * from highlights where archive_id = ?
           or entry_id = (select entry_id from archives where id = ? and entry_id is not null) order by id`,
        archiveId,
        archiveId,
      )
      .map(toHighlight);
  }

  get(id: number): Highlight | undefined {
    const r = this.db.get<HighlightRow>(`${LIST_SQL} where h.id = ?`, id);
    return r ? toHighlight(r) : undefined;
  }

  list(q: { q?: string; cursor?: string | null; limit?: number }): Page<Highlight> {
    const limit = Math.min(Math.max(q.limit || 50, 1), 200);
    const where: string[] = [];
    const params: Param[] = [];
    if (q.q?.trim()) {
      const fts = ftsQuery(q.q);
      if (fts) {
        where.push("h.id in (select rowid from highlights_fts where highlights_fts match ?)");
        params.push(fts);
      } else {
        where.push("(h.quote like ? escape '\\' or h.note like ? escape '\\')");
        params.push(likePattern(q.q), likePattern(q.q));
      }
    }
    if (q.cursor) {
      const [k, id] = q.cursor.split(":").map(Number);
      if (Number.isFinite(k) && Number.isFinite(id)) {
        where.push("(h.created_at < ? or (h.created_at = ? and h.id < ?))");
        params.push(k, k, id);
      }
    }
    const rows = this.db.all<HighlightRow>(
      `${LIST_SQL} ${where.length ? `where ${where.join(" and ")}` : ""} order by h.created_at desc, h.id desc limit ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toHighlight), nextCursor: more && last ? `${last.created_at}:${last.id}` : null };
  }

  create(h: { entryId: number | null; archiveId: number | null; quote: string; prefix?: string; suffix?: string; note?: string | null; color?: HighlightColor }): Highlight {
    const now = Date.now();
    const color = h.color && COLORS.includes(h.color) ? h.color : "amber";
    const id = this.db.run(
      `insert into highlights (entry_id, archive_id, quote, prefix, suffix, note, color, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      h.entryId,
      h.archiveId,
      h.quote,
      h.prefix || "",
      h.suffix || "",
      h.note || null,
      color,
      now,
      now,
    ).lastInsertRowid;
    this.index(id);
    return this.get(id)!;
  }

  update(id: number, patch: { note?: string | null; color?: HighlightColor }): Highlight | undefined {
    if (patch.note !== undefined) this.db.run("update highlights set note = ?, updated_at = ? where id = ?", patch.note || null, Date.now(), id);
    if (patch.color && COLORS.includes(patch.color)) this.db.run("update highlights set color = ?, updated_at = ? where id = ?", patch.color, Date.now(), id);
    this.index(id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.run("delete from highlights where id = ?", id).changes > 0;
  }

  /** Everything, oldest first, with the article each one belongs to (for exports). */
  all(): Highlight[] {
    return this.db.all<HighlightRow>(`${LIST_SQL} order by h.created_at, h.id`).map(toHighlight);
  }

  count(): number {
    return this.db.get<{ n: number }>("select count(*) n from highlights")?.n ?? 0;
  }

  private index(id: number): void {
    const r = this.db.get<{ quote: string; note: string | null }>("select quote, note from highlights where id = ?", id);
    this.db.run("delete from highlights_fts where rowid = ?", id);
    if (r) this.db.run("insert into highlights_fts (rowid, quote, note) values (?, ?, ?)", id, r.quote, r.note || "");
  }
}
