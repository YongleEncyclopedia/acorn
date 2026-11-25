/**
 * Push (推送): a subscription with an address of its own that anything can send messages to — an iPhone shortcut,
 * IFTTT / n8n / Zapier, a script, a server's alert, a bot. For sources that cannot be fetched at all. Messages come
 * in at POST /in/<token> (api/routes/inbox.ts); there is nothing to fetch.
 */
import type { AcornPlugin } from "../plugin-api.ts";
import type { ParsedItem } from "../parse.ts";
import { escapeHtml, sha1 } from "../../util/text.ts";
import { parseLooseDate } from "../../util/dates.ts";

export const inbox: AcornPlugin = {
  id: "inbox",
  name: "推送",
  description: "一个专属的推送地址：快捷指令、自动化工具、脚本或机器人把消息发过来，就成了这个订阅里的文章。",
  group: "hidden",
  params: [
    // the address of the subscription (not secret) and the key in the push address (secret)
    { key: "id", label: "编号", hidden: true, generate: true },
    { key: "token", label: "推送密钥", hidden: true, generate: true, secret: true },
  ],
  async fetch() {
    return { items: [] };
  },
};

type Fields = Record<string, unknown>;

const pick = (o: Fields, keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
};

const linkify = (escaped: string) => escaped.replace(/https?:\/\/[^\s<>"'，。；、）)]+/g, (u) => `<a href="${u}">${u}</a>`);

/** One message in whatever shape the sender has (title / text / url…, or Server酱's title + desp). */
export function pushedItem(o: Fields, now = Date.now()): ParsedItem | null {
  const text = pick(o, ["content", "html", "body", "text", "message", "msg", "desp", "desc", "description", "summary", "内容", "正文"]);
  const url = pick(o, ["url", "link", "href", "链接"]);
  let title = pick(o, ["title", "subject", "name", "标题"]);
  if (!title && !text && !url) return null;
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!title) title = plain ? ([...plain].length > 60 ? `${[...plain].slice(0, 60).join("")}…` : plain) : url;
  const html = !text ? null : /<\/?[a-z][^>]*>/i.test(text) ? text : `<p>${linkify(escapeHtml(text)).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
  const id = pick(o, ["id", "guid", "uuid"]);
  const publishedAt = parseLooseDate(pick(o, ["date", "time", "published", "created_at", "timestamp"])) ?? now;
  // without an id: the same message sent twice within a minute (a retry) is one article
  const guid = id ? `push:${id}` : url && !text ? url : `push:${sha1(`${title}|${text}|${url}|${Math.floor(publishedAt / 60_000)}`)}`;
  return { guid, url: /^https?:\/\//i.test(url) ? url : null, title, author: pick(o, ["author", "from", "source", "sender", "来源"]) || null, contentHtml: html, summary: null, image: pick(o, ["image", "img", "picture", "cover"]) || null, publishedAt };
}

/** A whole push: one message, a list of them, a form, or plain text (first line the title). */
export function pushedItems(body: unknown): ParsedItem[] {
  if (typeof body === "string") {
    const [first, ...rest] = body.trim().split("\n");
    const item = pushedItem({ title: first?.trim(), text: rest.join("\n").trim() });
    return item ? [item] : [];
  }
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as Fields).items) ? ((body as Fields).items as unknown[]) : [body];
  return list
    .slice(0, 50)
    .filter((x): x is Fields => !!x && typeof x === "object")
    .map((x) => pushedItem(x))
    .filter((x): x is ParsedItem => !!x);
}
