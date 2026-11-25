/**
 * JSON interfaces as subscriptions, without code. Many sites fill their pages from a JSON API (school notices,
 * news lists, app feeds): point at it, and Acorn finds the list in the answer and the fields that are the title,
 * link, date, body and picture (suggestJsonRule). Each can be corrected; a link can be a template such as
 * https://example.com/news/{id} when the API only gives ids.
 */
import type { AcornPlugin } from "../plugin-api.ts";
import { escapeHtml, sha1 } from "../../util/text.ts";
import { absolutize } from "../../util/url.ts";

/** A value at a dotted path ("data.list", "author.name", "images.0.url"); "" is the value itself. */
export function valueAt(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A field, or a template like https://example.com/news/{id} filled from the element. */
export function fill(template: string | undefined, el: unknown): string {
  if (!template) return "";
  if (!template.includes("{")) return text(valueAt(el, template));
  return template.replace(/\{([^{}]+)\}/g, (_, p: string) => encodeURIComponent(text(valueAt(el, p.trim()))));
}

// ───────────────────────── working out the mapping ─────────────────────────

type Obj = Record<string, unknown>;

/** Lists of objects anywhere in the answer, with where they are. */
function lists(data: unknown, at = "", depth = 0, out: { path: string; items: Obj[] }[] = []) {
  if (depth > 6) return out;
  if (Array.isArray(data)) {
    const objs = data.filter((x): x is Obj => !!x && typeof x === "object" && !Array.isArray(x));
    if (objs.length >= 2 && objs.length >= data.length * 0.8) out.push({ path: at, items: objs });
    return out;
  }
  if (data && typeof data === "object") for (const [k, v] of Object.entries(data)) lists(v, at ? `${at}.${k}` : k, depth + 1, out);
  return out;
}

/** An element's fields, nested objects flattened two levels down ("author.name", "images.0.url"). */
function fields(o: Obj, prefix = "", depth = 0, out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && depth < 2) {
      if (Array.isArray(v)) {
        if (v[0] && typeof v[0] === "object") fields(v[0] as Obj, `${p}.0`, depth + 1, out);
        else if (typeof v[0] === "string") out.set(`${p}.0`, v[0]);
      } else fields(v as Obj, p, depth + 1, out);
    } else out.set(p, v);
  }
  return out;
}

const URLISH = /^(https?:)?\/\/|^\/[\w%-]/i;
const IMAGEISH = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|$)|\/(img|image|images|pic|pics|cover|thumb)\//i;
const leaf = (p: string) => p.split(".").filter((s) => !/^\d+$/.test(s)).pop() || p;

function isDate(v: unknown): boolean {
  if (typeof v === "number") return (v > 946_684_800 && v < 4_102_444_800) || (v > 946_684_800_000 && v < 4_102_444_800_000);
  if (typeof v !== "string") return false;
  return /^\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}/.test(v.trim()) || (/^\d{10}(\d{3})?$/.test(v.trim()) && isDate(Number(v))) || (!Number.isNaN(Date.parse(v)) && /\d{4}/.test(v) && /[a-z]{3}|T\d/i.test(v));
}

interface Stats {
  path: string;
  filled: number;
  strings: number;
  avgLen: number;
  distinct: number;
  urls: number;
  images: number;
  dates: number;
  html: number;
}

function stats(path: string, values: unknown[]): Stats {
  const strs = values.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  const n = values.length || 1;
  return {
    path,
    filled: values.filter((v) => v !== null && v !== undefined && v !== "").length / n,
    strings: strs.length / n,
    avgLen: strs.length ? strs.reduce((a, s) => a + [...s].length, 0) / strs.length : 0,
    distinct: new Set(values.map((v) => JSON.stringify(v))).size / n,
    urls: strs.filter((s) => URLISH.test(s)).length / n,
    images: strs.filter((s) => URLISH.test(s) && IMAGEISH.test(s)).length / n,
    dates: values.filter(isDate).length / n,
    html: strs.filter((s) => /<\/?[a-z][^>]*>/i.test(s)).length / n,
  };
}

const best = <T,>(list: T[], score: (x: T) => number): T | undefined => {
  let top: T | undefined;
  let topScore = 0;
  for (const x of list) {
    const s = score(x);
    if (s > topScore) [top, topScore] = [x, s];
  }
  return top;
};

/** How a JSON answer maps to articles, or null when nothing in it looks like a list of them. */
export function suggestJsonRule(data: unknown): Record<string, string> | null {
  let winner: { score: number; rule: Record<string, string> } | null = null;
  for (const { path, items } of lists(data)) {
    const sample = items.slice(0, 30);
    const keys = new Map<string, unknown[]>();
    for (const o of sample) for (const [k, v] of fields(o)) (keys.get(k) ?? keys.set(k, []).get(k)!).push(v);
    for (const vals of keys.values()) while (vals.length < sample.length) vals.push(undefined);
    // fields starting with "_" are an API's own bookkeeping (search highlights, internal ids)
    const all = [...keys.entries()].filter(([k]) => !k.split(".").some((part) => part.startsWith("_"))).map(([k, v]) => stats(k, v));
    const named = (s: Stats, re: RegExp) => (re.test(leaf(s.path)) ? 1 : 0);
    const within = (s: Stats, re: RegExp) => (s.path.split(".").some((part) => re.test(part)) ? 1 : 0);

    const title = best(all, (s) =>
      s.strings < 0.7 || s.urls > 0.3 || s.dates > 0.3 || s.avgLen < 3 || s.avgLen > 200 ? 0 : 1 + s.distinct * 2 + named(s, /title|subject|headline|name|标题|caption/i) * 4 - named(s, /desc|summary|content|body|intro|abstract/i) * 2 + (s.avgLen >= 6 && s.avgLen <= 80 ? 1 : 0),
    );
    const link = best(all, (s) => (s.urls < 0.7 || s.images > 0.3 ? 0 : 1 + s.distinct + named(s, /url|link|href|permalink|uri|share|jump/i) * 3 - named(s, /img|image|pic|cover|thumb|avatar|icon|logo|video/i) * 3));
    const date = best(all, (s) => (s.dates < 0.7 ? 0 : 1 + named(s, /date|time|created|publish|pub|update|ctime|mtime|日期|时间/i) * 3 - named(s, /end|expire|deadline|modified/i)));
    const content = best(all, (s) => (s === title || s.strings < 0.5 || s.urls > 0.3 || s.avgLen < 30 || within(s, /title/i) ? 0 : 1 + Math.min(s.avgLen, 400) / 100 + s.html + named(s, /content|body|html|summary|desc|abstract|excerpt|intro|digest|text/i) * 3));
    const image = best(all, (s) => (s.images < 0.5 && !(s.urls >= 0.5 && named(s, /img|image|pic|cover|thumb|poster|banner/i)) ? 0 : 1 + named(s, /img|image|pic|cover|thumb|poster|banner/i) * 2));
    // "author", or the name of whoever posted it ("owner.name", "user.nickname")
    const author = best(all, (s) =>
      s === title || s.strings < 0.6 || s.avgLen < 1 || s.avgLen > 30 || s.urls > 0.2 ? 0 : named(s, /^(author|nickname|user_?name|uname|creator|publisher|source|from|作者|来源)$/i) * 3 + (within(s, /^(author|owner|user|creator|publisher|up)$/i) && named(s, /^(name|nickname|uname|screen_?name|display_?name)$/i) ? 3 : 0),
    );
    const id = best(all, (s) => (s.distinct < 0.95 || s.filled < 0.95 ? 0 : named(s, /^(id|_id|uuid|guid|aid|nid|article_?id|news_?id|item_?id|post_?id)$/i) * 3));
    if (!title && !content) continue;
    const score = Math.min(items.length, 30) + (title ? 6 : 0) + (link ? 3 : 0) + (date ? 3 : 0) + (content ? 1 : 0);
    if (!winner || score > winner.score) {
      const rule: Record<string, string> = { items: path };
      for (const [k, s] of Object.entries({ title, link, date, content, image, author, id })) if (s) rule[k] = s.path;
      winner = { score, rule };
    }
  }
  return winner?.rule ?? null;
}

// ───────────────────────── reading ─────────────────────────

/** Times without a zone on a Chinese site are Beijing time, wherever the server runs. */
function dateOf(v: unknown, chinese: boolean, parse: (x: unknown) => number | null): number | null {
  if (typeof v === "string" && chinese && /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(v.trim())) return Date.parse(`${v.trim().replace(" ", "T")}+08:00`) || null;
  if (typeof v === "string" && /^\d{10}(\d{3})?$/.test(v.trim())) return parse(Number(v));
  return parse(v);
}

/** The articles of a JSON answer under a mapping (exported for the tests and the browser's discovery). */
export function jsonItems(data: unknown, rule: Record<string, string>, base: string, parse: (x: unknown) => number | null) {
  const list = valueAt(data, rule.items);
  if (!Array.isArray(list)) throw new Error(`在返回的 JSON 里没找到「${rule.items || "（整个返回值）"}」这个列表`);
  const chinese = /\.cn$/i.test(new URL(base).hostname) || /[一-鿿]/.test(JSON.stringify(list).slice(0, 4000));
  return list
    .filter((el): el is Obj => !!el && typeof el === "object")
    .slice(0, 100)
    .map((el) => {
      const body = text(valueAt(el, rule.content));
      const html = !body ? null : /<\/?[a-z][^>]*>/i.test(body) ? body : `<p>${escapeHtml(body).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
      const words = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const title = text(valueAt(el, rule.title)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || (words.length > 60 ? `${words.slice(0, 60)}…` : words);
      const link = fill(rule.link, el);
      const id = text(valueAt(el, rule.id));
      const publishedAt = dateOf(valueAt(el, rule.date), chinese, parse);
      return {
        title,
        url: link ? absolutize(link, base) : null,
        guid: id ? `json:${id}` : undefined,
        content: html,
        image: absolutize(text(valueAt(el, rule.image)), base),
        author: text(valueAt(el, rule.author)) || null,
        publishedAt,
      };
    })
    .filter((it) => it.title);
}

export const json: AcornPlugin = {
  id: "json",
  name: "JSON 接口",
  description: "网站用来填充页面的 JSON 接口（学院通知、新闻列表、App 动态……）：填上接口地址，松果会认出里面的条目和标题、链接、日期等字段，也可以自己改。链接字段可以写成模板，比如 https://example.com/news/{id}。",
  group: "general",
  params: [
    { key: "url", label: "接口地址", required: true, placeholder: "https://…/api/list" },
    { key: "items", label: "条目列表的位置", placeholder: "data.list（空着 = 自动认）" },
    { key: "title", label: "标题字段", placeholder: "title" },
    { key: "link", label: "链接字段或模板", placeholder: "url，或 https://example.com/news/{id}" },
    { key: "date", label: "日期字段", placeholder: "publishTime" },
    { key: "content", label: "正文字段", placeholder: "content" },
    { key: "image", label: "图片字段", placeholder: "cover" },
    { key: "author", label: "作者字段", placeholder: "author.name" },
    { key: "id", label: "编号字段", placeholder: "id" },
    { key: "base", label: "相对链接的站点地址", placeholder: "https://example.com（空着 = 接口所在的站点）" },
  ],
  async fetch(ctx) {
    const url = (ctx.params.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("请填写 JSON 接口的地址");
    const res = await ctx.request(url, { accept: "application/json, text/plain, */*" });
    if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}`);
    let data: unknown;
    try {
      data = JSON.parse(res.text.replace(/^﻿/, ""));
    } catch {
      throw new Error("接口返回的不是 JSON");
    }
    // fields left empty are worked out from the answer
    const given = Object.fromEntries(Object.entries(ctx.params).filter(([, v]) => v));
    const rule = given.title || given.content ? given : { ...(suggestJsonRule(data) || {}), ...given };
    if (!rule.title && !rule.content) throw new Error("没能在返回的 JSON 里认出条目，请手动填写条目位置和标题字段");
    const base = rule.base || new URL(res.url || url).origin;
    const items = jsonItems(data, rule, base, ctx.parseDate);
    return { title: new URL(base).host, siteUrl: base, items: items.map((it) => ({ ...it, guid: it.guid ?? (it.url || `json:${sha1(`${it.title}|${it.publishedAt ?? ""}`)}`) })) };
  },
};
