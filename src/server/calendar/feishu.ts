/**
 * Writing the class calendar into Feishu through its open platform (calendar v4), as a 企业自建应用 the user
 * creates: the app owns a public shared calendar 「班级日历」 and keeps its events in step, creating, updating and
 * removing them, remembered by key in calendar_sync so nothing is written twice.
 */
import type { App } from "../app.ts";
import type { ClassEvent } from "../../shared/types.ts";
import { sha1 } from "../util/text.ts";
import { KIND_LABEL } from "./merge.ts";

interface Answer<T> {
  code: number;
  msg?: string;
  data?: T;
  tenant_access_token?: string;
}

// what Feishu's error codes mean for someone setting the app up (from the calendar v4 documentation)
const HINTS: Record<number, string> = {
  190007: "应用还没有开启「机器人」能力",
  191002: "应用对这个日历没有写入权限",
  191004: "日历类型不对，请清空日历 ID 后重新同步",
  99991672: "应用还没有开通日历权限（calendar:calendar），或者开通后还没发布新版本",
  99991663: "应用凭证无效",
};

const fail = (what: string, a: Answer<unknown>) => new Error(`${what}：${HINTS[a.code] || `飞书返回 ${a.code}${a.msg ? ` ${a.msg}` : ""}`}`);

async function call<T>(base: string, method: string, path: string, token: string | null, body?: unknown): Promise<Answer<T>> {
  const res = await fetch(`${base}/open-apis${path}`, {
    method,
    headers: { "content-type": "application/json; charset=utf-8", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json().catch(() => ({ code: res.status, msg: `HTTP ${res.status}` }))) as Answer<T>;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function describe(e: ClassEvent): string {
  const due = e.due ? "这是截止时间，日历上显示为截止前的半小时。" : "";
  if (e.mine && e.count === 1) return `${due}来自课程的 Canvas 公告或测验安排，由松果整理。`;
  return `${due}${e.count} 位同学有这项${KIND_LABEL[e.kind]}。由松果从课程公告和同学自愿分享的日历合成，只计人数，不记是谁。`;
}

/** The event as Feishu takes it. Attendees are not notified: the calendar is for looking up, not for alerts. */
export function eventBody(e: ClassEvent) {
  const time = (ms: number) => (e.allDay ? { date: day(ms) } : { timestamp: String(Math.round(ms / 1000)), timezone: "Asia/Shanghai" });
  return { summary: e.title, description: describe(e), need_notification: false, free_busy_status: "busy", start_time: time(e.start), end_time: time(e.allDay ? e.start : e.end) };
}

export interface FeishuSync {
  created: number;
  updated: number;
  removed: number;
  calendarId: string;
}

/** Bring the Feishu calendar in step with `events`; `keep` are the keys still present anywhere (older ones included). */
export async function syncFeishu(app: App, events: ClassEvent[], keep: Set<string>): Promise<FeishuSync> {
  const st = app.calendar.state();
  if (!st.feishuAppId || !st.feishuAppSecret) throw new Error("还没有填写飞书应用的 App ID 和 App Secret");
  const base = app.cfg.feishuBase;
  const auth = await call(base, "POST", "/auth/v3/tenant_access_token/internal", null, { app_id: st.feishuAppId, app_secret: st.feishuAppSecret });
  if (auth.code !== 0 || !auth.tenant_access_token) throw fail("没能用 App ID 和 App Secret 取得飞书凭证", auth);
  const token = auth.tenant_access_token;

  let calendarId = st.feishuCalendarId;
  if (!calendarId) {
    const r = await call<{ calendar: { calendar_id: string } }>(base, "POST", "/calendar/v4/calendars", token, {
      summary: "班级日历",
      description: "同学们的小测、实验、考试等安排，由松果从自愿分享的 Canvas 日历合成，只计人数，不记是谁。",
      permissions: "public",
    });
    if (r.code !== 0 || !r.data?.calendar?.calendar_id) throw fail("没能创建飞书日历", r);
    calendarId = r.data.calendar.calendar_id;
    app.calendar.setState({ feishuCalendarId: calendarId });
    app.calendar.forgetSynced(); // events written to an earlier calendar are not in this one
  }
  const cal = encodeURIComponent(calendarId);
  const synced = app.calendar.synced();
  const out: FeishuSync = { created: 0, updated: 0, removed: 0, calendarId };
  for (const e of events) {
    const body = eventBody(e);
    const hash = sha1(JSON.stringify(body));
    const had = synced.get(e.key);
    if (had?.hash === hash) continue;
    if (had) {
      const r = await call(base, "PATCH", `/calendar/v4/calendars/${cal}/events/${encodeURIComponent(had.remoteId)}`, token, body);
      if (r.code === 0) {
        app.calendar.markSynced(e.key, had.remoteId, hash);
        out.updated++;
        continue;
      }
      // deleted in Feishu by someone: written anew below
    }
    const r = await call<{ event: { event_id: string } }>(base, "POST", `/calendar/v4/calendars/${cal}/events?idempotency_key=${sha1(`${calendarId}|${e.key}|${hash}`)}`, token, body);
    if (r.code !== 0 || !r.data?.event?.event_id) throw fail(`没能写入「${e.title}」`, r);
    app.calendar.markSynced(e.key, r.data.event.event_id, hash);
    out.created++;
  }
  // gone from everyone's calendar (cancelled, or the classmates who had it withdrew)
  for (const [key, s] of synced) {
    if (keep.has(key)) continue;
    await call(base, "DELETE", `/calendar/v4/calendars/${cal}/events/${encodeURIComponent(s.remoteId)}`, token);
    app.calendar.forgetSynced(key);
    out.removed++;
  }
  app.calendar.setState({ feishuSyncedAt: Date.now(), feishuError: null });
  return out;
}
