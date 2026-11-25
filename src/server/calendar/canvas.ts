/**
 * The owner's own Canvas, read for the class calendar. Exams, quizzes and labs are announced in 公告 rather than
 * put on Canvas's calendar, so the configured AI model reads them out of the announcements (each announcement once,
 * cached); quizzes and assignments with a due date come straight from the planner. Announcements are the course's,
 * the same for everyone in it: one student's Canvas covers every course they share with the class.
 */
import type { App } from "../app.ts";
import type { IcsEvent } from "./ics.ts";
import { zonedToUtc } from "./ics.ts";
import { accountFor } from "../accounts/use.ts";
import { pluginContext } from "../feeds/plugins.ts";
import { listAnnouncements, listPlanner, type Announcement } from "../feeds/builtin/canvas.ts";
import { complete } from "../translate/engine.ts";
import { htmlToText, sha1 } from "../util/text.ts";
import { logger } from "../util/log.ts";

const log = logger("calendar");
const DAY = 86_400_000;
const CACHE = "events:v1";

/** The class calendar's source for an account's Canvas (a member row of its own; it has no link to fetch). */
export const ownCanvasUrl = (accountId: number) => `acorn:canvas/${accountId}`;
export const ownCanvasId = (url: string): number | null => Number(url.match(/^acorn:canvas\/(\d+)$/)?.[1]) || null;

// an announcement that mentions none of these has no assessment to find: it is not sent to the model
const MENTIONS = /\b(exams?|quiz(zes)?|tests?|midterms?|finals?|labs?|presentations?|defen[cs]e)\b|考试|测验|小测|随堂|实验|期中|期末|答辩|展示|汇报/i;

const PROMPT = `You read a university course announcement and list the scheduled assessments in it: exams, quizzes, labs, presentations.
Reply with JSON only, in this shape:
{"events":[{"kind":"exam|quiz|lab|presentation","title":"short name, e.g. Exam 3","date":"YYYY-MM-DD","start":"HH:MM or null","end":"HH:MM or null","location":"room or null"}]}
Rules:
- Only events whose date is written in the announcement. Never guess a date.
- A date without a year belongs to the year of the posting date (or the next year, if it would otherwise lie before it).
- Times are local time in China, 24-hour.
- Homework due dates are not events, unless the announcement calls them a quiz, exam or lab.
- Nothing scheduled: {"events":[]}`;

export interface Found {
  kind: "exam" | "quiz" | "lab" | "presentation";
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  location: string | null;
}

const KINDS = new Set(["exam", "quiz", "lab", "presentation"]);
const hhmm = (v: unknown): string | null => (typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim().padStart(5, "0") : null);

/**
 * What the model found, kept only where the announcement bears it out: a real date near the posting date whose
 * day of the month is written in the text (a model that invents a date is caught here).
 */
export function checkFound(reply: string, text: string, posted: number): Found[] {
  const json = reply.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/)?.[0];
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray((raw as { events?: unknown }).events) ? ((raw as { events: Record<string, unknown>[] }).events) : [];
  const out: Found[] = [];
  for (const e of list) {
    const m = String(e.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m || !KINDS.has(String(e.kind))) continue;
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(at) || Math.abs(at - posted) > 300 * DAY) continue;
    const day = String(Number(m[3]));
    if (!new RegExp(`(^|[^0-9])0?${day}([^0-9]|$)`).test(text)) continue;
    out.push({
      kind: String(e.kind) as Found["kind"],
      title: String(e.title || e.kind).trim().slice(0, 80),
      date: `${m[1]}-${m[2]}-${m[3]}`,
      start: hhmm(e.start),
      end: hhmm(e.end),
      location: typeof e.location === "string" && e.location.trim() ? e.location.trim().slice(0, 60) : null,
    });
  }
  return out;
}

// how long an assessment with a start but no end is taken to last
const LENGTH: Record<Found["kind"], number> = { exam: 120, quiz: 45, lab: 120, presentation: 60 };

/** A found assessment as a calendar item. The same exam in two announcements (a notice, a reminder) is one item. */
export function toEvent(f: Found, course: string): IcsEvent {
  const [y, mo, d] = f.date.split("-").map(Number);
  const where = f.location ? ` · ${f.location}` : "";
  const uid = `canvas-${f.kind}-${sha1(`${course}|${f.date}|${f.start || ""}`).slice(0, 12)}`;
  if (!f.start) return { uid, summary: `${f.title}${where} [${course}]`, start: Date.UTC(y, mo - 1, d), end: Date.UTC(y, mo - 1, d), allDay: true };
  const at = (t: string) => zonedToUtc(y, mo, d, Number(t.slice(0, 2)), Number(t.slice(3)), 0, "Asia/Shanghai");
  const start = at(f.start);
  const end = f.end && at(f.end) > start ? at(f.end) : start + LENGTH[f.kind] * 60_000;
  return { uid, summary: `${f.title}${where} [${course}]`, start, end, allDay: false };
}

/**
 * One exam told twice (a notice with the time, a reminder with only the date) is one item: an all-day finding is
 * dropped when the same course has one of the same kind with a time on that date.
 */
export function dedupe(found: (Found & { course: string })[]): (Found & { course: string })[] {
  const timed = new Set(found.filter((f) => f.start).map((f) => `${f.course}|${f.kind}|${f.date}`));
  return found.filter((f) => f.start || !timed.has(`${f.course}|${f.kind}|${f.date}`));
}

async function readAnnouncement(app: App, a: Announcement & { course: string | null }): Promise<(Found & { course: string })[]> {
  const text = `${a.title || ""}\n${htmlToText(a.message || "")}`;
  if (!a.course || !MENTIONS.test(text)) return [];
  const posted = Date.parse(a.posted_at || "") || Date.now();
  const key = sha1(`${a.id}|${text}`);
  const hit = app.translations.get([key], CACHE).get(key);
  let found: Found[];
  if (hit) found = (JSON.parse(hit) as { events: Found[] }).events;
  else {
    const cfg = app.settings.all().translate;
    const user = `Posted: ${new Date(posted).toISOString().slice(0, 10)}\nCourse: ${a.course}\nTitle: ${a.title || ""}\n\n${text.slice(0, 6000)}`;
    found = checkFound(await complete(cfg, PROMPT, user), text, posted);
    app.translations.put(key, CACHE, JSON.stringify({ events: found }), cfg.model);
  }
  return found.map((f) => ({ ...f, course: a.course! }));
}

/** Everything the class calendar takes from an account's Canvas. A failure of the model leaves the due dates. */
export async function readOwnCanvas(app: App, accountId: number): Promise<{ events: IcsEvent[]; problem: string | null }> {
  const account = await accountFor(app, "canvas", accountId);
  if (!account) throw new Error("这个 Canvas 账号已经删除了：在 设置 → 账号 里重新连接");
  const ctx = pluginContext("canvas", {}, app.cfg.pageUserAgent, account);
  const now = Date.now();
  const [anns, plan] = await Promise.all([listAnnouncements(ctx, 120), listPlanner(ctx, now - 30 * DAY, 3)]);
  const events: IcsEvent[] = [];
  for (const p of plan) {
    const due = Date.parse(p.plannable?.due_at || "");
    if (!(p.plannable_type === "quiz" || p.plannable_type === "assignment") || !due || !p.context_name) continue;
    events.push({ uid: `canvas-${p.plannable_type}-${p.plannable_id}`, summary: `${p.plannable?.title || p.plannable?.name || "作业"} [${p.context_name}]`, start: due, end: due, allDay: false });
  }
  let problem: string | null = null;
  const found: (Found & { course: string })[] = [];
  for (const a of anns) {
    try {
      found.push(...(await readAnnouncement(app, a)));
    } catch (err) {
      // the AI service is down or not set up: the rest still counts, and the next refresh tries again
      problem = `没能用 AI 读公告：${(err as Error).message}`;
      log.warn(problem);
      break;
    }
  }
  events.push(...dedupe(found).map((f) => toEvent(f, f.course)));
  const seen = new Set<string>();
  return { events: events.filter((e) => !seen.has(e.uid) && seen.add(e.uid)), problem };
}
