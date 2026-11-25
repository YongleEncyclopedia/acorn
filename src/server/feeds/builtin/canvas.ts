/**
 * Canvas, the learning platform many schools run (交大: oc.sjtu.edu.cn): course announcements, discussions,
 * the inbox, grading and what is due, read with an access token the student creates in Canvas
 * (账户 → 设置 → 创建新访问许可证) through Canvas's documented REST API.
 */
import type { AcornPlugin, PluginContext } from "../plugin-api.ts";
import { LoginExpiredError } from "../plugin-api.ts";
import type { Credential } from "../../store/accounts.ts";
import type { Service } from "../../accounts/services.ts";
import { escapeHtml } from "../../util/text.ts";

const SJTU = "https://oc.sjtu.edu.cn";

const auth = (cred: Pick<Credential, "token" | "cookie">): Record<string, string> =>
  cred.token ? { authorization: `Bearer ${cred.token}` } : cred.cookie ? { cookie: cred.cookie } : {};

export const canvasService: Service = {
  id: "canvas",
  name: "Canvas",
  origin: SJTU,
  originEditable: true,
  browserLogin: false,
  manual: {
    kind: "token",
    label: "访问令牌",
    placeholder: "粘贴 Canvas 生成的访问令牌",
    link: `${SJTU}/profile/settings#access_tokens_holder`,
    steps: [
      "打开 Canvas 的「账户 → 设置」页面（交大：oc.sjtu.edu.cn/profile/settings）",
      "在页面下方点「创建新访问许可证」（英文界面是 New Access Token），用途写「松果」，到期日可以留空",
      "复制生成的令牌（只显示这一次），粘贴到这里",
    ],
  },
  headers: auth,
  assets: /^\/(?:(?:courses|users|groups)\/\d+\/)?files\/\d+(?:\/|$)/,
  async whoami(cred, origin, get) {
    const res = await get(`${origin}/api/v1/users/self`, { ...auth(cred), accept: "application/json" });
    if (res.status === 401 || res.status === 403) throw new LoginExpiredError("Canvas 不接受这个访问令牌：它可能写错了、过期了或者被删除了");
    if (res.status !== 200) throw new Error(`Canvas 返回 HTTP ${res.status}，请确认地址是不是 Canvas`);
    const me = JSON.parse(res.text) as { name?: string; short_name?: string };
    return me.short_name || me.name || "Canvas 用户";
  },
};

// ───────────────────────── reading ─────────────────────────

interface Page<T> {
  data: T;
  next: string | null;
}

/** One page of a Canvas list; the next page's address comes in the Link header. */
async function page<T>(ctx: PluginContext, url: string): Promise<Page<T>> {
  const res = await ctx.request(url, { headers: auth(ctx.account!), accept: "application/json" });
  if (res.status === 401) ctx.loginExpired("Canvas 的访问令牌失效了（过期或者被删除），请在 设置 → 账号 里换一个新的");
  if (!res.ok) throw new Error(`Canvas 返回 HTTP ${res.status}`);
  const next = (res.headers.get("link") || "").split(",").find((l) => /rel="next"/.test(l))?.match(/<([^>]+)>/)?.[1] || null;
  return { data: JSON.parse(res.text) as T, next };
}

/** A whole list, up to `max` pages. */
async function all<T>(ctx: PluginContext, url: string, max = 4): Promise<T[]> {
  const out: T[] = [];
  let at: string | null = url;
  for (let i = 0; at && i < max; i++) {
    const p: Page<T[]> = await page<T[]>(ctx, at);
    out.push(...p.data);
    at = p.next;
  }
  return out;
}

interface Course {
  id: number;
  name?: string;
  course_code?: string;
}

export async function courses(ctx: PluginContext): Promise<Map<number, string>> {
  const list = await all<Course>(ctx, `${ctx.account!.origin}/api/v1/courses?enrollment_state=active&per_page=100`);
  return new Map(list.map((c) => [c.id, c.name || c.course_code || `课程 ${c.id}`]));
}

/** Dates in the school's time: a Chinese school's due dates read in China time wherever the server runs. */
function when(iso: string | null | undefined, origin: string): string {
  if (!iso) return "";
  const zone = /\.cn$/i.test(new URL(origin).hostname) ? "Asia/Shanghai" : undefined;
  return new Date(iso).toLocaleString("zh-CN", { timeZone: zone, month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

const abs = (url: string | null | undefined, origin: string) => (url ? new URL(url, origin).href : null);

/**
 * Canvas links a file to its preview page (`/courses/1/files/2?verifier=…&wrap=1`), which is an HTML wrapper; the
 * file itself is at `…/files/2/download`. Linking there lets the reader open it and archiving keep it.
 */
export function directFileLinks(html: string, origin: string): string {
  return html.replace(/(<a\b[^>]*?\shref=")([^"]*?\/files\/\d+)(?:\/preview)?(\?[^"]*)?(")/gi, (m, a: string, path: string, query: string | undefined, b: string) => {
    let u: URL;
    try {
      u = new URL(path + (query || "").replace(/&amp;/g, "&"), origin);
    } catch {
      return m;
    }
    if (u.origin !== origin) return m;
    u.pathname += "/download";
    u.searchParams.delete("wrap");
    u.searchParams.set("download_frd", "1");
    return `${a}${u.href.replace(/&/g, "&amp;")}${b}`;
  });
}

// what the activity stream calls each kind of thing
const STREAM: Record<string, string> = {
  Announcement: "公告",
  DiscussionTopic: "讨论",
  Conversation: "收件箱",
  Message: "通知",
  Submission: "作业",
  Conference: "会议",
  Collaboration: "协作",
  AssessmentRequest: "互评",
};

interface StreamItem {
  id: number;
  type: string;
  title?: string;
  message?: string;
  html_url?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  course_id?: number;
  grade?: string | null;
  score?: number | null;
  assignment?: { name?: string };
  course?: { name?: string };
  submission_comments?: { author_name?: string; comment?: string }[];
}

async function stream(ctx: PluginContext) {
  const origin = ctx.account!.origin;
  const [names, list] = await Promise.all([courses(ctx), all<StreamItem>(ctx, `${origin}/api/v1/users/self/activity_stream?per_page=50`, 2)]);
  return list.map((it) => {
    const label = STREAM[it.type] || "动态";
    const course = (it.course_id && names.get(it.course_id)) || it.course?.name || null;
    let content = directFileLinks(it.message || "", origin);
    let title = it.title || "";
    if (it.type === "Submission") {
      title = `${it.assignment?.name || it.title || "作业"}${it.grade ? ` · 成绩 ${it.grade}` : ""}`;
      const comments = (it.submission_comments || []).filter((c) => c.comment).map((c) => `<p><b>${escapeHtml(c.author_name || "老师")}：</b>${escapeHtml(c.comment!)}</p>`);
      content = [it.grade ? `<p>成绩：${escapeHtml(it.grade)}${typeof it.score === "number" ? `（${it.score} 分）` : ""}</p>` : "", ...comments].join("");
    }
    return {
      title: `${label}｜${title || label}`,
      url: abs(it.html_url || it.url, origin),
      guid: `canvas:${it.type}:${it.id}`,
      content: content || null,
      author: course,
      publishedAt: it.created_at || it.updated_at || null,
    };
  });
}

export interface Announcement {
  id: number;
  title?: string;
  message?: string;
  html_url?: string;
  posted_at?: string;
  context_code?: string;
  author?: { display_name?: string };
}

/** The announcements of the student's active courses from the last `days` days, each with its course's name. */
export async function listAnnouncements(ctx: PluginContext, days = 120): Promise<(Announcement & { course: string | null })[]> {
  const origin = ctx.account!.origin;
  const names = await courses(ctx);
  if (!names.size) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // without an end date Canvas stops 28 days after the start
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const codes = [...names.keys()].map((id) => `context_codes[]=course_${id}`).join("&");
  const list = await all<Announcement>(ctx, `${origin}/api/v1/announcements?${codes}&start_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(until)}&per_page=50`);
  return list.map((a) => ({ ...a, course: names.get(Number((a.context_code || "").replace("course_", ""))) || null }));
}

async function announcements(ctx: PluginContext) {
  const origin = ctx.account!.origin;
  const list = await listAnnouncements(ctx);
  return list.map((a) => {
    const course = a.course;
    return {
      title: a.title || "课程公告",
      url: abs(a.html_url, origin),
      guid: `canvas:announcement:${a.id}`,
      content: a.message ? directFileLinks(a.message, origin) : null,
      author: [course, a.author?.display_name].filter(Boolean).join(" · ") || null,
      publishedAt: a.posted_at || null,
    };
  });
}

export interface PlannerItem {
  plannable_id: number;
  plannable_type: string;
  plannable_date?: string;
  plannable?: { title?: string; name?: string; due_at?: string | null; points_possible?: number | null; created_at?: string };
  html_url?: string;
  context_name?: string;
  submissions?: false | { submitted?: boolean; graded?: boolean; missing?: boolean; late?: boolean; excused?: boolean };
}

const PLANNED: Record<string, string> = { assignment: "作业", quiz: "测验", discussion_topic: "讨论", calendar_event: "日程", wiki_page: "页面" };

/** What the student's planner holds from `since` on: assignments, quizzes, discussions, events. */
export async function listPlanner(ctx: PluginContext, since: number, pages = 2): Promise<PlannerItem[]> {
  return all<PlannerItem>(ctx, `${ctx.account!.origin}/api/v1/planner/items?start_date=${encodeURIComponent(new Date(since).toISOString())}&per_page=100`, pages);
}

async function todo(ctx: PluginContext) {
  const origin = ctx.account!.origin;
  const list = await listPlanner(ctx, Date.now() - 3 * 86_400_000);
  return list
    .filter((p) => PLANNED[p.plannable_type])
    .map((p) => {
      const due = p.plannable?.due_at || p.plannable_date || null;
      const s = p.submissions || {};
      const state = s.excused ? "已免交" : s.graded ? "已批改" : s.submitted ? "已提交" : s.missing ? "缺交" : "未提交";
      const name = p.plannable?.title || p.plannable?.name || PLANNED[p.plannable_type];
      const facts = [
        p.context_name ? `课程：${p.context_name}` : "",
        due ? `截止：${when(due, origin)}` : "",
        typeof p.plannable?.points_possible === "number" ? `满分：${p.plannable.points_possible}` : "",
        p.submissions ? `状态：${state}` : "",
      ].filter(Boolean);
      return {
        title: `${PLANNED[p.plannable_type]}｜${name}${due ? `（${when(due, origin)} 截止）` : ""}`,
        url: abs(p.html_url, origin),
        guid: `canvas:plan:${p.plannable_type}:${p.plannable_id}`,
        content: facts.map((f) => `<p>${escapeHtml(f)}</p>`).join(""),
        author: p.context_name || null,
        publishedAt: p.plannable?.created_at || p.plannable_date || null,
      };
    });
}

const WHAT = [
  { value: "stream", label: "全部动态：公告、讨论、收件箱、作业批改……" },
  { value: "announcements", label: "课程公告" },
  { value: "todo", label: "待办：作业、测验的截止时间" },
];

export const canvas: AcornPlugin = {
  id: "canvas",
  name: "Canvas",
  description: "Canvas 学习平台（交大 oc.sjtu.edu.cn 等）：课程公告、讨论、收件箱、作业批改和截止时间。需要先连接 Canvas 账号（在 Canvas 里创建一个访问令牌）。",
  account: "canvas",
  params: [{ key: "what", label: "内容", options: WHAT }],
  async fetch(ctx) {
    if (!ctx.account?.token && !ctx.account?.cookie) ctx.loginExpired("Canvas 还没有登录");
    const what = WHAT.some((w) => w.value === ctx.params.what) ? ctx.params.what : "stream";
    const items = what === "announcements" ? await announcements(ctx) : what === "todo" ? await todo(ctx) : await stream(ctx);
    const label = WHAT.find((w) => w.value === what)!.label.split("：")[0];
    return { title: `Canvas · ${label}`, siteUrl: ctx.account!.origin, items };
  },
};

