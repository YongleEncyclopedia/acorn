/**
 * 班级日历: classmates' Canvas calendar links (shared of their own will) merged into one calendar of the class's
 * quizzes, labs and exams, as counts without names; published as an .ics link and, if set up, a Feishu calendar.
 */
import type { App } from "../app.ts";
import type { ClassEvent } from "../../shared/types.ts";
import { decodeBody, httpGet } from "../util/http.ts";
import { logger } from "../util/log.ts";
import { parseIcs, writeIcs, type IcsEvent } from "./ics.ts";
import { mergeEvents } from "./merge.ts";
import { describe, syncFeishu, type FeishuSync } from "./feishu.ts";
import { ownCanvasId, readOwnCanvas } from "./canvas.ts";

const log = logger("calendar");
const DAY = 86_400_000;

/** A calendar link's events, or why there are none. */
export async function readLink(app: App, url: string): Promise<IcsEvent[]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("这不是一个网址");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("日历链接应该以 https:// 开头");
  const res = await httpGet(u.href, { userAgent: app.cfg.pageUserAgent, accept: "text/calendar,*/*;q=0.5", timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024 });
  if (!res.ok) throw new Error(res.status === 404 || res.status === 401 ? "链接打不开了：可能已经失效，请对方重新复制一次" : `日历返回 HTTP ${res.status}`);
  const text = decodeBody(res.body, res.contentType);
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("这个链接里不是日历：请复制 Canvas「日历」页右下角的「日历订阅」链接");
  const now = Date.now();
  // only what scheduling needs: from two months back to half a year ahead
  return parseIcs(text).filter((e) => e.end >= now - 60 * DAY && e.start <= now + 180 * DAY);
}

/** Fetch every member's link again. */
export async function refreshMembers(app: App): Promise<void> {
  for (const m of app.calendar.links()) {
    try {
      const own = ownCanvasId(m.url);
      if (own) {
        const { events, problem } = await readOwnCanvas(app, own);
        app.calendar.setEvents(m.id, events);
        if (problem) app.calendar.setError(m.id, problem);
      } else app.calendar.setEvents(m.id, await readLink(app, m.url));
    } catch (err) {
      app.calendar.setError(m.id, (err as Error).message);
    }
  }
  app.calendar.setState({ refreshedAt: Date.now() });
}

export function classEvents(app: App, from: number, to: number): ClassEvent[] {
  const { minCount, include } = app.calendar.state();
  return mergeEvents(app.calendar.allEvents(), { minCount, include, from, to, own: app.calendar.ownIds() });
}

/** The class calendar as an .ics file, for Apple, Google and Outlook calendars (and anything else that subscribes). */
export function classIcs(app: App): string {
  const now = Date.now();
  const events = classEvents(app, now - 30 * DAY, now + 180 * DAY);
  return writeIcs(
    "班级日历",
    events.map((e) => ({ uid: `${e.key}@acorn-class`, summary: e.title, description: describe(e), start: e.start, end: e.end, allDay: e.allDay })),
    now,
  );
}

let running: Promise<FeishuSync | null> | null = null;

/** Fetch the links again, then bring the Feishu calendar in step (when an app is set up). */
export function syncClassCalendar(app: App): Promise<FeishuSync | null> {
  if (running) return running;
  running = (async () => {
    await refreshMembers(app);
    const st = app.calendar.state();
    if (!st.feishuAppId || !st.feishuAppSecret) return null;
    const now = Date.now();
    try {
      const r = await syncFeishu(app, classEvents(app, now - 30 * DAY, now + 180 * DAY), new Set(classEvents(app, 0, Infinity).map((e) => e.key)));
      log.info(`feishu calendar: ${r.created} new, ${r.updated} updated, ${r.removed} removed`);
      return r;
    } catch (err) {
      app.calendar.setState({ feishuError: (err as Error).message });
      throw err;
    }
  })().finally(() => (running = null));
  return running;
}
