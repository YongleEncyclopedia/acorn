/**
 * Pages with neither a feed nor a list (a notice board, a price, a status or an exam-results page): Acorn keeps
 * the page's text and adds an article whenever it changes, saying what was added and what went away. A CSS
 * selector narrows it to the part that matters, so clocks and visitor counters elsewhere do not count as changes.
 */
import type { AcornPlugin } from "../plugin-api.ts";
import { escapeHtml } from "../../util/text.ts";

const DROP = "script, style, noscript, template, svg, iframe, link, meta, [hidden], [aria-hidden=true]";
const BLOCK = new Set(["P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "MAIN", "UL", "OL", "TABLE", "TBODY", "THEAD", "DL", "DT", "DD", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "FORM", "TD", "TH"]);

/** A region's text as lines, the way it reads on screen (blocks on their own lines). */
export function pageLines(root: Element): string[] {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) return void parts.push(n.textContent || "");
    if (n.nodeType !== 1) return;
    const tag = (n as Element).tagName.toUpperCase();
    if (tag === "BR") return void parts.push("\n");
    const block = BLOCK.has(tag);
    if (block) parts.push("\n");
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block) parts.push("\n");
  };
  walk(root);
  const lines = parts
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.filter((l, i) => l !== lines[i - 1]);
}

/** What was added and what went away, line by line. */
export function diffLines(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return { added: after.filter((l) => !was.has(l)), removed: before.filter((l) => !now.has(l)) };
}

const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);
const list = (lines: string[], tag: "li" | "del") => `<ul>${lines.slice(0, 60).map((l) => (tag === "del" ? `<li><del>${escapeHtml(l)}</del></li>` : `<li>${escapeHtml(l)}</li>`)).join("")}</ul>${lines.length > 60 ? `<p>……还有 ${lines.length - 60} 行</p>` : ""}`;

export const watch: AcornPlugin = {
  id: "watch",
  name: "网页变化",
  description: "没有订阅源、也没有文章列表的网页（公告栏、价格、状态页、成绩公布页……）：松果定期打开它，内容一变就记一篇，写明新增和删去了什么。用选择器只看页面上的一部分，别处的时钟、访问量就不会算成变化。",
  group: "general",
  params: [
    { key: "url", label: "网页地址", required: true, placeholder: "https://…" },
    { key: "selector", label: "只看这一部分（CSS 选择器）", placeholder: "#notice、.price（空着 = 整个页面）" },
  ],
  async fetch(ctx) {
    const url = (ctx.params.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("请填写要关注的网页地址");
    const selector = (ctx.params.selector || "").trim();
    const { document } = ctx.parseHTML(await ctx.fetchText(url));
    const page = document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() || new URL(url).host;
    const root = selector ? document.querySelector(selector) : document.body;
    if (selector && !root) throw new Error(`页面上没有找到「${selector}」：选择器写错了，或者这一部分是脚本后来加上的`);
    if (!root) throw new Error("页面是空的");
    for (const el of Array.from(root.querySelectorAll(DROP))) el.remove();
    const lines = pageLines(root);
    if (!lines.length) throw new Error("这一部分没有文字：页面可能是靠脚本加载内容的，可以试试「用浏览器识别」");
    const now = Date.now();
    const before = ctx.state.get<string[]>("lines");
    ctx.state.set("lines", lines);
    if (!before) {
      return {
        title: page,
        siteUrl: url,
        items: [{ guid: "watch:start", title: `${page}（开始关注）`, url, content: `<p>松果开始关注${selector ? `这个页面的「${escapeHtml(selector)}」部分` : "这个页面"}，内容有变化时会记一篇。现在的内容：</p>${list(lines, "li")}`, publishedAt: now }],
      };
    }
    const { added, removed } = diffLines(before, lines);
    if (!added.length && !removed.length) return { title: page, siteUrl: url, items: [] };
    const head = added[0] ? clip(added[0], 40) : `删去了「${clip(removed[0], 30)}」`;
    const content = [
      `<p>新增 ${added.length} 行，删去 ${removed.length} 行。</p>`,
      added.length ? `<h3>新增</h3>${list(added, "li")}` : "",
      removed.length ? `<h3>删去</h3>${list(removed, "del")}` : "",
    ].join("");
    return { title: page, siteUrl: url, items: [{ guid: `watch:${now}`, title: `${page}：${head}`, url, content, publishedAt: now }] };
  },
};
