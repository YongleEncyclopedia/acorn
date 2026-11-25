/**
 * 交我办 (my.sjtu.edu.cn), Shanghai Jiao Tong University's portal: the messages the school's systems send a
 * student (学生事务, 财务, 图书馆, Canvas 日历…), which the app and the web portal show under 消息. The portal's
 * session is short-lived; it is renewed through jAccount single sign-on with the jAccount cookie, the way the
 * browser does it, so a sign-in lasts as long as jAccount's does. No password is ever stored or sent.
 */
import type { AcornPlugin, PluginContext } from "../plugin-api.ts";
import { LoginExpiredError } from "../plugin-api.ts";
import type { BrowserCookie, Service } from "../../accounts/services.ts";
import type { Credential, Jar } from "../../store/accounts.ts";
import { BROWSER_UA } from "../../config.ts";
import { escapeHtml } from "../../util/text.ts";

const PORTAL = "https://my.sjtu.edu.cn";

// ───────────────────────── cookies across the portal and jAccount ─────────────────────────

/** The cookies a request to `host` carries: the host's own, and those of the domains it belongs to. */
export function cookiesFor(jar: Jar, host: string): string {
  const out: string[] = [];
  for (const [key, cookies] of Object.entries(jar)) {
    const applies = key === host || (key.startsWith(".") && (host === key.slice(1) || host.endsWith(key)));
    if (applies) for (const [name, value] of Object.entries(cookies)) out.push(`${name}=${value}`);
  }
  return out.join("; ");
}

/** Keep what a response sets, and drop what it deletes. A domain attribute counts only for the host's own domains. */
export function keepCookies(jar: Jar, host: string, setCookies: string[]): void {
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";").map((p) => p.trim());
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const attr = (n: string) => attrs.find((a) => a.toLowerCase().startsWith(`${n}=`))?.slice(n.length + 1).trim();
    const domain = attr("domain")?.toLowerCase().replace(/^\./, "");
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) continue;
    const key = domain ? `.${domain}` : host;
    const maxAge = attr("max-age");
    const expires = attr("expires");
    const gone = !value || (maxAge !== undefined && Number(maxAge) <= 0) || (!!expires && Date.parse(expires) < Date.now());
    if (gone) delete jar[key]?.[name];
    else (jar[key] ||= {})[name] = value;
  }
}

/** The browser's cookies of the portal and jAccount, as a jar. */
export function jarFromBrowser(cookies: BrowserCookie[]): Jar {
  const jar: Jar = {};
  for (const c of cookies) {
    if (!/(^|\.)sjtu\.edu\.cn$/i.test(c.domain.replace(/^\./, ""))) continue;
    (jar[c.domain.toLowerCase()] ||= {})[c.name] = c.value;
  }
  return jar;
}

/** A GET that keeps cookies and does not follow redirects (the caller decides where to go). */
async function get(jar: Jar, url: string, accept: string): Promise<Response> {
  const u = new URL(url);
  const res = await fetch(url, { headers: { cookie: cookiesFor(jar, u.host), "user-agent": BROWSER_UA, accept }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  keepCookies(jar, u.host, res.headers.getSetCookie());
  return res;
}

/**
 * A new portal session through jAccount: the portal sends the browser to jAccount, which (still signed in) sends it
 * straight back with a code. false when jAccount asks for the password again: the user signs in anew.
 */
export async function renewSession(jar: Jar, origin: string): Promise<boolean> {
  const portal = new URL(origin);
  delete jar[portal.host]; // the old session is no use
  let url = `${origin}/ui/task/`;
  for (let hop = 0; hop < 12; hop++) {
    const res = await get(jar, url, "text/html,*/*");
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) return res.ok && new URL(url).origin === portal.origin;
    url = new URL(location, url).href;
  }
  return false;
}

interface Answer<T> {
  errno?: number;
  message?: string;
  error?: string | null;
  total?: number;
  entities?: T[];
}

/** A portal API call, renewing the session once when it has ended. */
export async function portal<T>(jar: Jar, origin: string, path: string): Promise<Answer<T>> {
  let renewed = false;
  let blank = 0;
  for (;;) {
    const res = await get(jar, `${origin}${path}`, "application/json");
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel();
      if (!renewed && (await renewSession(jar, origin))) {
        renewed = true;
        continue;
      }
      throw new LoginExpiredError("交我办（jAccount）的登录已过期");
    }
    if (!res.ok) throw new Error(`交我办返回 HTTP ${res.status}`);
    // now and then the portal answers 200 with nothing (or a page) where the JSON should be: ask once more
    const body = parseAnswer<T>(await res.text());
    if (!body) {
      if (blank++ < 1) {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      throw new Error("交我办这次没有正常回答（返回了空内容），下次更新会再试");
    }
    if (body.errno !== 0) throw new Error(`交我办出错了：${body.message || body.error || `errno ${body.errno}`}`);
    return body;
  }
}

/** How long to wait before asking the portal again after an empty answer. */
const RETRY_MS = 1500;

function parseAnswer<T>(text: string): Answer<T> | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Answer<T>) : null;
  } catch {
    return null;
  }
}

// ───────────────────────── messages ─────────────────────────

interface Group {
  groupId: string;
  groupName: string;
  isGroup: boolean;
  createTime?: string;
}

interface Message {
  messageId: string;
  title?: string | null;
  description?: string | null;
  pushTitle?: string | null;
  pushContent?: string | null;
  createTime?: string;
  authClient?: { name?: string } | null;
  context?: { key?: string; value?: string }[] | null;
  urlList?: unknown;
}

/** The portal's times are Shanghai time without a zone: read them as such wherever the server runs. */
export const shanghai = (t: string | undefined): number | null => (t ? Date.parse(`${t.trim().replace(" ", "T")}+08:00`) || null : null);

// one-time codes (网络信息中心 sends 验证码) are of no use later, and are not something to keep
const CODE = /验证码|校验码|动态码|动态密码|verification code|one-time code/i;

/** A link's words: the site and the start of the path (sign-up links run to a hundred characters). */
const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    const text = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  } catch {
    return url;
  }
};

const linkify = (escaped: string) => escaped.replace(/https?:\/\/[^\s<>"'，。；、）)]+/g, (u) => `<a href="${u}">${escapeHtml(shortUrl(u.replace(/&amp;/g, "&")))}</a>`);

const links = (v: unknown): { url: string; name?: string }[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === "string" ? { url: x } : x && typeof x === "object" ? { url: String((x as Record<string, unknown>).url || (x as Record<string, unknown>).href || ""), name: String((x as Record<string, unknown>).name || (x as Record<string, unknown>).title || "") || undefined } : { url: "" }))
    .filter((l) => /^https?:\/\//i.test(l.url));

export function messageItem(m: Message, g: Group, origin: string) {
  const rows = (Array.isArray(m.context) ? m.context : []).filter((c) => c && c.value);
  const parts = rows.map((c) => {
    const v = String(c.value).trim();
    const label = c.key && c.key !== "内容" ? `<b>${escapeHtml(c.key)}：</b>` : "";
    if (/^https?:\/\/\S+$/i.test(v)) return `<p>${label}<a href="${escapeHtml(v)}">${escapeHtml(shortUrl(v))}</a></p>`;
    return `<p>${label}${linkify(escapeHtml(v)).replace(/\n/g, "<br>")}</p>`;
  });
  if (!parts.length && m.pushContent) parts.push(`<p>${linkify(escapeHtml(m.pushContent)).replace(/\n/g, "<br>")}</p>`);
  for (const l of links(m.urlList)) parts.push(`<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.name || shortUrl(l.url))}</a></p>`);
  const what = (m.description || m.pushTitle || "").trim();
  // a message that points somewhere (a Canvas assignment, a form) opens there; the others open in the portal
  const target = rows.map((c) => String(c.value).trim()).find((v) => /^https?:\/\/\S+$/i.test(v)) || links(m.urlList)[0]?.url;
  return {
    title: m.title ? `${m.title} · ${what}` : what || m.pushTitle || "交我办消息",
    url: target || `${origin}/ui/message/detail?name=${encodeURIComponent(g.groupName)}&groupId=${encodeURIComponent(g.groupId)}&isGroup=${g.isGroup}&isRead=true`,
    guid: `jwb:${m.messageId}`,
    content: parts.join("") || null,
    author: m.authClient?.name || g.groupName,
    publishedAt: shanghai(m.createTime),
  };
}

const isCode = (m: Message) => [m.title, m.description, m.pushTitle, m.pushContent, ...(m.context || []).map((c) => c?.value)].some((t) => !!t && CODE.test(t));

async function groups(jar: Jar, origin: string): Promise<Group[]> {
  const out: Group[] = [];
  for (let page = 0; page < 4; page++) {
    const r = await portal<Group>(jar, origin, `/api/jwbmessage/group?key=&page=${page}&pageSize=50&read=false`);
    out.push(...(r.entities || []));
    if (!r.entities?.length || out.length >= (r.total ?? 0)) break;
  }
  return out;
}

// a source quiet for this long is not asked for its messages on every refresh
const QUIET = 45 * 86_400_000;

async function messages(jar: Jar, origin: string, g: Group): Promise<Message[]> {
  const r = await portal<Message>(jar, origin, `/api/jwbmessage/messagelist?page=0&pageSize=20&key=&groupId=${encodeURIComponent(g.groupId)}&isGroup=${g.isGroup}&read=true`);
  return r.entities || [];
}

// ───────────────────────── the account and the plugin ─────────────────────────

const jarOf = (cred: Credential): Jar => (cred.jar ||= {});

export const jwbService: Service = {
  id: "jwb",
  name: "交我办",
  origin: PORTAL,
  originEditable: false,
  browserLogin: true,
  manual: {
    kind: "cookie",
    label: "JAAuthCookie",
    placeholder: "jAccount 的 JAAuthCookie",
    link: `${PORTAL}/ui/task/`,
    steps: [
      "在电脑浏览器打开 my.sjtu.edu.cn，用 jAccount 登录（扫码或密码）",
      "打开开发者工具 → Application（应用）→ Cookies → https://jaccount.sjtu.edu.cn",
      "复制 JAAuthCookie 的值，粘贴到这里。松果用它续上交我办的登录，不保存密码",
    ],
  },
  login: {
    url: (origin) => `${origin}/ui/task/`,
    cookieUrls: (origin) => [`${origin}/`, "https://jaccount.sjtu.edu.cn/", "https://jaccount.sjtu.edu.cn/jaccount/"],
    need: ["JAAuthCookie"],
    fromCookies: (cookies) => (cookies.some((c) => c.name === "JAAuthCookie") ? { jar: jarFromBrowser(cookies) } : null),
  },
  fromManual: (value) => {
    const jar: Jar = { "jaccount.sjtu.edu.cn": {} };
    if (value.includes("=")) keepCookies(jar, "jaccount.sjtu.edu.cn", value.split(/;\s*/));
    else jar["jaccount.sjtu.edu.cn"].JAAuthCookie = value.trim();
    return { jar };
  },
  headers: (cred) => ({ cookie: cookiesFor(cred.jar || {}, new URL(PORTAL).host) }),
  async whoami(cred, origin) {
    const r = await portal<{ name?: string }>(jarOf(cred), origin, "/api/account");
    return r.entities?.[0]?.name || "交大同学";
  },
};

function signIn(ctx: PluginContext): { jar: Jar; origin: string } {
  if (!ctx.account?.jar) ctx.loginExpired("交我办还没有登录");
  return { jar: ctx.account!.jar!, origin: ctx.account!.origin };
}

export const jwb: AcornPlugin = {
  id: "jwb",
  name: "交我办",
  description: "上海交大「交我办」的消息：学校各个系统发给你的通知（学生事务、财务、图书馆、Canvas 日历……），可以全部订阅，也可以只订其中一个来源。需要先连接交我办账号（jAccount）。验证码类消息不会收进来。",
  account: "jwb",
  params: [{ key: "group", label: "来源", fromAccount: true, placeholder: "来源的 ID" }],
  async choices(ctx, key) {
    if (key !== "group") return [];
    const { jar, origin } = signIn(ctx);
    const list = await groups(jar, origin);
    return [{ value: "all", label: "全部消息" }, ...list.map((g) => ({ value: g.groupId, label: g.groupName }))];
  },
  async fetch(ctx) {
    const { jar, origin } = signIn(ctx);
    const want = ctx.params.group && ctx.params.group !== "all" ? ctx.params.group : null;
    const all = await groups(jar, origin);
    const chosen = want ? all.filter((g) => g.groupId === want) : all.filter((g) => (shanghai(g.createTime) ?? 0) > Date.now() - QUIET);
    if (want && !chosen.length) throw new Error("交我办里没有这个消息来源了");
    const items = [];
    for (const g of chosen) for (const m of await messages(jar, origin, g)) if (!isCode(m)) items.push(messageItem(m, g, origin));
    return { title: want ? `交我办 · ${chosen[0].groupName}` : "交我办", siteUrl: `${origin}/ui/message/`, items };
  },
};
