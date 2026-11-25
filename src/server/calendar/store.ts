import type { Db } from "../db/index.ts";
import type { ClassCalendarConfig, ClassMember } from "../../shared/types.ts";
import type { IcsEvent } from "./ics.ts";

const CONFIG = "_classCalendar";

/** What the server keeps besides the public config: the Feishu app secret and the calendar it made. */
export interface CalendarState extends ClassCalendarConfig {
  feishuAppSecret: string;
  /** The key of the .ics link: its own, so the link opens the class calendar and nothing else of the library. */
  icsKey: string;
  /** When the links were last fetched. */
  refreshedAt: number | null;
}

export const DEFAULT_CALENDAR: CalendarState = {
  minCount: 3,
  include: "important",
  feishuAppId: "",
  feishuAppSecret: "",
  feishuCalendarId: "",
  feishuSyncedAt: null,
  feishuError: null,
  icsKey: "",
  refreshedAt: null,
};

/** Masked like the AI key: a member's link is theirs, and never goes back out whole. */
const maskUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}/…${u.pathname.slice(-6)}`;
  } catch {
    return "…";
  }
};

interface MemberRow {
  id: number;
  name: string;
  url: string;
  created_at: number;
  checked_at: number | null;
  error: string | null;
  events: number;
}

/** 班级日历: the classmates' calendar links, what they held at the last fetch, and what was written to Feishu. */
export class CalendarStore {
  private db: Db;
  private settings: { getRaw(k: string): string | undefined; setRaw(k: string, v: string): void };
  constructor(db: Db, settings: { getRaw(k: string): string | undefined; setRaw(k: string, v: string): void }) {
    this.db = db;
    this.settings = settings;
  }

  state(): CalendarState {
    try {
      return { ...DEFAULT_CALENDAR, ...(JSON.parse(this.settings.getRaw(CONFIG) || "{}") as Partial<CalendarState>) };
    } catch {
      return { ...DEFAULT_CALENDAR };
    }
  }

  setState(patch: Partial<CalendarState>): CalendarState {
    const next = { ...this.state(), ...patch };
    this.settings.setRaw(CONFIG, JSON.stringify(next));
    return next;
  }

  members(): ClassMember[] {
    return this.db
      .all<MemberRow>("select m.*, (select count(*) from calendar_member_events e where e.member_id = m.id) as events from calendar_members m order by m.created_at")
      .map((r) => ({ id: r.id, name: r.name, link: r.url.startsWith("acorn:") ? "" : maskUrl(r.url), createdAt: r.created_at, checkedAt: r.checked_at, error: r.error, events: r.events, own: r.url.startsWith("acorn:") }));
  }

  /** The member rows that are the owner's own sources (their Canvas): theirs to show by name. */
  ownIds(): Set<number> {
    return new Set(this.db.all<{ id: number }>("select id from calendar_members where url like 'acorn:%'").map((r) => r.id));
  }

  /** For fetching: the links themselves. */
  links(): { id: number; url: string }[] {
    return this.db.all<{ id: number; url: string }>("select id, url from calendar_members order by id");
  }

  /** A new member, or the same link under a new name. */
  addMember(name: string, url: string): void {
    this.db.run("insert into calendar_members (name, url, created_at) values (?, ?, ?) on conflict(url) do update set name = excluded.name", name, url, Date.now());
  }

  /** A member who withdrew: their link and everything it held go. */
  removeMember(id: number): boolean {
    this.db.run("delete from calendar_member_events where member_id = ?", id);
    return this.db.run("delete from calendar_members where id = ?", id).changes > 0;
  }

  setEvents(memberId: number, events: IcsEvent[]): void {
    this.db.tx(() => {
      this.db.run("delete from calendar_member_events where member_id = ?", memberId);
      for (const e of events)
        this.db.run(
          "insert or replace into calendar_member_events (member_id, uid, summary, start_at, end_at, all_day) values (?, ?, ?, ?, ?, ?)",
          memberId,
          e.uid,
          e.summary,
          e.start,
          e.end,
          e.allDay ? 1 : 0,
        );
      this.db.run("update calendar_members set checked_at = ?, error = null where id = ?", Date.now(), memberId);
    });
  }

  setError(memberId: number, error: string): void {
    this.db.run("update calendar_members set checked_at = ?, error = ? where id = ?", Date.now(), error, memberId);
  }

  /** Every member's events, with who had them (ids only: names never leave this store for the calendar). */
  allEvents(): (IcsEvent & { memberId: number })[] {
    return this.db
      .all<{ member_id: number; uid: string; summary: string; start_at: number; end_at: number; all_day: number }>("select * from calendar_member_events")
      .map((r) => ({ memberId: r.member_id, uid: r.uid, summary: r.summary, start: r.start_at, end: r.end_at, allDay: !!r.all_day }));
  }

  synced(): Map<string, { remoteId: string; hash: string }> {
    return new Map(this.db.all<{ key: string; remote_id: string; hash: string }>("select key, remote_id, hash from calendar_sync").map((r) => [r.key, { remoteId: r.remote_id, hash: r.hash }]));
  }

  markSynced(key: string, remoteId: string, hash: string): void {
    this.db.run("insert into calendar_sync (key, remote_id, hash, synced_at) values (?, ?, ?, ?) on conflict(key) do update set remote_id = excluded.remote_id, hash = excluded.hash, synced_at = excluded.synced_at", key, remoteId, hash, Date.now());
  }

  forgetSynced(key?: string): void {
    if (key) this.db.run("delete from calendar_sync where key = ?", key);
    else this.db.run("delete from calendar_sync");
  }
}
