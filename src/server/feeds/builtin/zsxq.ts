/**
 * 知识星球 (zsxq.com): the topics of the 星球 the user joined, read with their own sign-in. The web client
 * (wx.zsxq.com, signed in by scanning a QR code with the app or WeChat) keeps the sign-in in the cookie
 * `zsxq_access_token`; the same API it uses gives a 星球's topics (RSSHub's zsxq route works the same way).
 */
import type { AcornPlugin, PluginContext } from "../plugin-api.ts";
import { LoginExpiredError } from "../plugin-api.ts";
import type { Get, Service } from "../../accounts/services.ts";
import { escapeHtml } from "../../util/text.ts";

const WEB = "https://wx.zsxq.com";

/** The API lives on its own host; a stand-in server (the tests) serves it at its own address. */
const apiBase = (origin: string) => (origin === WEB ? "https://api.zsxq.com" : origin);

interface Answer<T> {
  succeeded?: boolean;
  code?: number;
  info?: string;
  error?: string;
  resp_data?: T;
}

export async function zsxqApi<T>(get: Get, origin: string, token: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await get(`${apiBase(origin)}/v2${path}`, { cookie: `zsxq_access_token=${token}`, accept: "application/json" });
    if (res.status === 401 || res.status === 403) throw new LoginExpiredError("知识星球的登录已过期");
    let body: Answer<T>;
    try {
      body = JSON.parse(res.text) as Answer<T>;
    } catch {
      throw new Error(`知识星球返回了无法识别的内容（HTTP ${res.status}）`);
    }
    if (body.succeeded) return body.resp_data as T;
    // 1059 comes now and then and goes away when asked again (RSSHub retries it too)
    if (body.code === 1059 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }
    const why = body.info || body.error || "";
    if (body.code === 401 || /登录|token|授权|过期/i.test(why)) throw new LoginExpiredError("知识星球的登录已过期");
    throw new Error(`知识星球的接口出错了（code ${body.code ?? "未知"}${why ? `：${why}` : ""}）`);
  }
}

// ───────────────────────── turning a topic into an article ─────────────────────────

interface Image {
  thumbnail?: { url?: string };
  large?: { url?: string };
  original?: { url?: string };
}
interface Owner {
  name?: string;
}
interface Body {
  text?: string;
  images?: Image[];
  files?: { name?: string; size?: number }[];
  owner?: Owner;
  article?: { title?: string; article_url?: string; inline_article_url?: string };
}
export interface Topic {
  topic_id?: number | string;
  type?: string;
  title?: string;
  create_time?: string;
  digested?: boolean;
  talk?: Body;
  question?: Body;
  answer?: Body;
  answered?: boolean;
  task?: Body;
  solution?: Body;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const attr = (tag: string, name: string): string => decode(tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] || "");

/** zsxq marks links, hashtags, mentions and bold text in the plain text with <e …/> tags. */
export function topicText(text = ""): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(/<e\s[^>]*\/>/g)) {
    out += escapeHtml(text.slice(at, m.index));
    at = m.index! + m[0].length;
    const tag = m[0];
    const type = attr(tag, "type");
    const title = attr(tag, "title");
    if (type === "web") {
      const href = attr(tag, "href");
      out += /^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(title || href)}</a>` : escapeHtml(title);
    } else if (type === "text_bold") out += `<b>${escapeHtml(title)}</b>`;
    else out += escapeHtml(title); // hashtag (#…#) and mention (@…) titles carry their own sign
  }
  out += escapeHtml(text.slice(at));
  return out.replace(/\n/g, "<br>");
}

/** A topic's text as plain lines, its marks replaced by their words. */
const lines = (text = ""): string[] =>
  text
    .replace(/<e\s[^>]*\/>/g, (tag) => attr(tag, "title"))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

// a first line that only greets ("卡老师好！", "星主好", "老师您好") says nothing about the topic
const GREETING = /^.{0,8}(老师|星主|督工|大佬|前辈|学长|学姐|各位|大家|您|你)好[!！~～。，,]*$/;

/**
 * What a list shows for a topic: its first line, past a greeting. (The API has a `title` of its own, but it is
 * cut after a dozen characters, and for a question it is the start of the answer.)
 */
export function headline(text = ""): string {
  // punctuation left over from the line before ("。（负面，谨慎观看）") does not start a title
  const ls = lines(text)
    .map((l) => l.replace(/^[。，、,.!！?？;；:：~～…\s]+/, ""))
    .filter(Boolean);
  if (ls.length > 1 && GREETING.test(ls[0])) ls.shift();
  const first = ls[0] || "";
  // a long first line (a question, a paragraph) is told by its first sentence, closing quotes included
  const sentence = first.match(/^.{6,}?[。！？!?][”’」』）)]*/)?.[0];
  if (sentence && sentence.length <= 40) return sentence;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

function bodyHtml(b: Body | undefined): string {
  if (!b) return "";
  const parts = [topicText(b.text)];
  if (b.article?.title) {
    const href = b.article.article_url || b.article.inline_article_url;
    parts.push(href ? `<p>📄 <a href="${escapeHtml(href)}">${escapeHtml(b.article.title)}</a></p>` : `<p>📄 ${escapeHtml(b.article.title)}</p>`);
  }
  for (const img of b.images || []) {
    const src = img.large?.url || img.original?.url || img.thumbnail?.url;
    if (src) parts.push(`<p><img src="${escapeHtml(src)}"></p>`);
  }
  // attachments need the app to download; their names say what is there
  for (const f of b.files || []) if (f.name) parts.push(`<p>📎 ${escapeHtml(f.name)}</p>`);
  return parts.filter(Boolean).join("");
}

const firstImage = (b: Body | undefined) => b?.images?.map((i) => i.large?.url || i.original?.url || i.thumbnail?.url).find(Boolean) || null;

const KIND: Record<string, string> = { "q&a": "问答", task: "作业", solution: "作业" };

export function topicItem(t: Topic) {
  const main = t.talk || t.question || t.task || t.solution;
  let content = bodyHtml(main);
  if (t.type === "q&a") {
    const asker = t.question?.owner?.name || "匿名用户";
    content = `<blockquote><p>${escapeHtml(asker)} 提问：</p>${bodyHtml(t.question)}</blockquote>`;
    if (t.answered && t.answer) content += `<p><b>${escapeHtml(t.answer.owner?.name || "星主")} 回答：</b></p>${bodyHtml(t.answer)}`;
  }
  const words = main?.article?.title || headline(main?.text);
  const kind = KIND[t.type || ""];
  const fallback = (t.title || "").replace(/^「(.+)」$/, "$1").replace(/(\.{3}|…)$/, "").trim();
  const title = words ? (t.type === "q&a" ? `问：${words}` : words) : main?.images?.length ? "图片" : fallback || kind || "星球动态";
  return {
    title,
    url: `${WEB}/topic/${t.topic_id}`,
    guid: `zsxq:${t.topic_id}`,
    content,
    author: (t.type === "q&a" ? t.answer?.owner?.name : main?.owner?.name) || null,
    image: firstImage(main) || firstImage(t.answer),
    publishedAt: t.create_time || null,
  };
}

// ───────────────────────── the account and the plugin ─────────────────────────

export const zsxqService: Service = {
  id: "zsxq",
  name: "知识星球",
  origin: WEB,
  originEditable: false,
  browserLogin: true,
  manual: {
    kind: "token",
    label: "zsxq_access_token",
    placeholder: "从浏览器 Cookie 里复制",
    link: WEB,
    steps: [
      "在电脑浏览器打开 wx.zsxq.com，用知识星球 App 或微信扫码登录（网页版和手机看到的星球是一样的）",
      "打开开发者工具 → Application（应用）→ Cookies → https://wx.zsxq.com",
      "复制 zsxq_access_token 的值，粘贴到这里",
    ],
  },
  login: {
    url: () => `${WEB}/`,
    cookieUrls: () => [`${WEB}/`, "https://api.zsxq.com/"],
    need: ["zsxq_access_token"],
    fromCookies: (cookies) => {
      const token = cookies.find((c) => c.name === "zsxq_access_token")?.value;
      return token ? { token } : null;
    },
  },
  headers: (cred): Record<string, string> => {
    const cookie = cred.token ? `zsxq_access_token=${cred.token}` : cred.cookie;
    return cookie ? { cookie } : {};
  },
  async whoami(cred, origin, get) {
    if (!cred.token) throw new LoginExpiredError("缺少 zsxq_access_token");
    const r = await zsxqApi<{ user?: { name?: string } }>(get, origin, cred.token, "/users/self");
    return r.user?.name || "知识星球用户";
  },
};

const SCOPES = [
  { value: "all", label: "最新" },
  { value: "digests", label: "精华" },
  { value: "by_owner", label: "只看星主" },
  { value: "questions", label: "问答" },
  { value: "tasks", label: "作业" },
];

const viaContext = (ctx: PluginContext): Get => async (url, headers) => {
  const res = await ctx.request(url, { headers });
  return { status: res.status, text: res.text };
};

/** The account's token, or a clear word that the sign-in is missing. */
function token(ctx: PluginContext): string {
  if (!ctx.account?.token) ctx.loginExpired("知识星球还没有登录");
  return ctx.account!.token!;
}

export const zsxq: AcornPlugin = {
  id: "zsxq",
  name: "知识星球",
  description: "你加入的星球里的新帖子：主题、问答、作业，连同图片。需要先连接知识星球账号（扫码登录网页版）。",
  account: "zsxq",
  params: [
    { key: "group", label: "星球", required: true, fromAccount: true, placeholder: "星球 ID，网页版地址里的数字" },
    { key: "scope", label: "栏目", options: SCOPES },
  ],
  async choices(ctx, key) {
    if (key !== "group") return [];
    const r = await zsxqApi<{ groups?: { group_id?: number | string; name?: string }[] }>(viaContext(ctx), ctx.account!.origin, token(ctx), "/groups");
    return (r.groups || []).filter((g) => g.group_id).map((g) => ({ value: String(g.group_id), label: g.name || String(g.group_id) }));
  },
  async fetch(ctx) {
    const id = (ctx.params.group || "").trim().replace(/^.*\/group\/(\d+).*$/, "$1");
    if (!/^\d+$/.test(id)) throw new Error("请填写星球 ID（网页版地址 wx.zsxq.com/group/ 后面的数字）");
    const scope = SCOPES.some((s) => s.value === ctx.params.scope) ? ctx.params.scope : "all";
    const get = viaContext(ctx);
    const origin = ctx.account!.origin;
    const { group } = await zsxqApi<{ group?: { name?: string; description?: string } }>(get, origin, token(ctx), `/groups/${id}`);
    const { topics } = await zsxqApi<{ topics?: Topic[] }>(get, origin, token(ctx), `/groups/${id}/topics?scope=${scope}&count=20`);
    const label = SCOPES.find((s) => s.value === scope)!.label;
    return {
      title: `${group?.name || "知识星球"}${scope === "all" ? "" : ` · ${label}`}`,
      siteUrl: `${WEB}/group/${id}`,
      description: group?.description,
      items: (topics || []).filter((t) => t.topic_id).map(topicItem),
    };
  },
};
