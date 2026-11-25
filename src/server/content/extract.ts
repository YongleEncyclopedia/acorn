import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { sanitize } from "./sanitize.ts";
import { ruleFor, type RuleResult } from "./rules/index.ts";
import { absolutize } from "../util/url.ts";
import { countWords, excerpt as makeExcerpt, htmlToText } from "../util/text.ts";
import { parseLooseDate } from "../util/dates.ts";

export interface Extracted {
  title: string;
  byline: string | null;
  siteName: string | null;
  publishedAt: number | null;
  lang: string | null;
  /** Sanitized article HTML with absolute URLs. */
  contentHtml: string;
  text: string;
  excerpt: string;
  leadImage: string | null;
  wordCount: number;
  rule: string | null;
}

const LAZY = ["data-src", "data-original", "data-actualsrc", "data-lazy-src", "data-lazyload", "data-echo", "data-original-src"];

function meta(doc: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"]`) || doc.querySelector(`meta[name="${n}"]`) || doc.querySelector(`meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

/** Make lazy images real and every link/image absolute, so Readability and the archiver see final URLs. */
function normalize(doc: Document, base: string): void {
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:") || /blank|placeholder|spacer|loading/i.test(src)) {
      for (const k of LAZY) {
        const v = img.getAttribute(k);
        if (v && !v.startsWith("data:")) {
          img.setAttribute("src", v);
          break;
        }
      }
    }
    const abs = absolutize(img.getAttribute("src"), base);
    if (abs) img.setAttribute("src", abs);
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const abs = absolutize(a.getAttribute("href"), base);
    if (abs) a.setAttribute("href", abs);
  }
}

/** "少数派 - 高品质数字消费指南" → "少数派"; "The Verge | Tech News" → "The Verge". */
export function cleanSiteName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.replace(/\s+/g, " ").trim();
  const first = n.split(/\s+[-|–—·]\s+/)[0]?.trim();
  return first && first.length >= 2 ? first : n || null;
}

/** Content containers of CMS platforms common on Chinese university / government sites (博达 VSB, WebPlus, TRS…). */
const CMS_SELECTORS = [
  "#vsb_content",
  ".v_news_content",
  ".wp_articlecontent",
  ".Article_Content",
  ".TRS_Editor",
  ".trs_editor_view",
  "#zoom",
  ".article-content",
  ".article_content",
  ".news_content",
  ".newsContent",
  ".detail-content",
  ".xl_content",
  ".content-con",
];
export const ATTACHMENT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|wps|et|dps)(\?|$)|download\.jsp|DownloadAttachUrl|attachment/i;

function cmsContent(doc: Document): string | null {
  for (const sel of CMS_SELECTORS) {
    const el = doc.querySelector(sel);
    if (!el || (el.textContent || "").trim().length < 10) continue;
    // Attachment lists usually sit next to the body (inside the same form / parent), not inside it.
    const scope = el.closest("form") || el.parentElement;
    const seen = new Set([...el.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
    const extra = scope
      ? [...scope.querySelectorAll("a[href]")].filter((a) => !seen.has(a.getAttribute("href")) && ATTACHMENT_RE.test(`${a.getAttribute("href")} ${a.textContent}`))
      : [];
    const attachments = extra.length
      ? `<h3>附件</h3><ul>${extra.map((a) => `<li><a href="${a.getAttribute("href")}">${(a.textContent || a.getAttribute("href") || "").trim()}</a></li>`).join("")}</ul>`
      : "";
    return el.innerHTML + attachments;
  }
  return null;
}

/** Readability's `charThreshold`: a pick shorter than this is the longest of its failed attempts, not a find. */
const CHAR_THRESHOLD = 140;
/** Less text than this (and no image) is not an article. */
const MIN_TEXT = 30;

/**
 * What the page itself marks as its content: its only top-level <article> (looked for inside <main> when there is
 * one, never in a sidebar, nav or footer), else its <main>.
 */
function markedContent(doc: Document): Element | null {
  const main = doc.querySelector("main, [role=main]");
  const articles = [...(main || doc).querySelectorAll("article")].filter((a) => !a.parentElement?.closest("article") && !a.closest("aside, nav, footer"));
  return articles.length === 1 ? articles[0]! : main;
}

/** Lines only a site footer has: copyright, ICP licence and police record numbers. */
const FOOTER_MARK = /版权所有|copyright|©|all rights reserved|ICP\s*[备证]|公网安备/i;
/** Words footer lines are made of: those marks, the owner's address and contacts, who runs the site, link rows, counters. */
const FOOTER_WORDS = /版权|copyright|©|rights reserved|ICP|公网安备|公安备案|(地址|电话|邮编|邮政编码|传真|邮箱|e-?mail|主办|承办|维护)(单位)?\s*[:：]|技术支持|设计制作|powered by|网站地图|联系我们|友情链接|访问量|访客/i;

/**
 * A site footer and little else: it has a copyright or ICP line, and the lines without footer words add up to less
 * than a paragraph Readability would count (25 characters), or less than a third of the text.
 */
function isFooter(text: string): boolean {
  if (!FOOTER_MARK.test(text)) return false;
  const rest = squash(text.split("\n").filter((line) => !FOOTER_WORDS.test(line)).join(""));
  return rest.length < Math.max(25, squash(text).length / 3);
}

/** Whether every line of `text` occurs in `within`, ignoring spaces and punctuation. */
function linesWithin(text: string, within: string): boolean {
  const all = squash(within);
  return text.split("\n").every((line) => all.includes(squash(line)));
}

export interface ExtractOptions {
  /** Feed-specific CSS selector for the article body. */
  contentSelector?: string;
}

const LABELED_DATE = /(?:发布|发表|发文|更新|上传)(?:日期|时间)\s*[:：]\s*(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/;

/**
 * Turn a full HTML page into a clean article. Order: site rule → explicit selector → CMS containers (institutional
 * hosts first, everyone else last) → Readability, whose unsure picks give way to the page's own <article> / <main>.
 * Returns null when nothing article-like could be found.
 */
export function extractArticle(html: string, pageUrl: string, opts: ExtractOptions = {}): Extracted | null {
  const { document: doc } = parseHTML(html);
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = (baseHref && absolutize(baseHref, pageUrl)) || pageUrl;
  normalize(doc, base);

  const metaTitle = meta(doc, "og:title", "twitter:title") || doc.querySelector("title")?.textContent?.trim() || "";
  const metaSite = meta(doc, "og:site_name", "application-name");
  const metaAuthor = meta(doc, "author", "article:author", "byline");
  const metaPublished =
    parseLooseDate(meta(doc, "article:published_time", "og:published_time", "pubdate", "publishdate", "datePublished", "publish_date", "PubDate")) ??
    parseLooseDate(doc.querySelector("time[datetime]")?.getAttribute("datetime"));
  // Chinese CMS pages print it in the text: "发布日期：2026-07-29", "发布时间：2026年7月29日 10:00".
  const visible = html.slice(0, 400_000).replace(/<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|\u00a0/g, " ");
  const labeledPublished = parseLooseDate(visible.match(LABELED_DATE)?.[1]);
  const metaImage = absolutize(meta(doc, "og:image", "twitter:image", "og:image:url"), base);
  const lang = doc.documentElement?.getAttribute("lang") || null;

  let result: RuleResult | null = null;
  let ruleName: string | null = null;
  const rule = ruleFor(pageUrl);
  if (rule?.extract) {
    try {
      result = rule.extract(doc, new URL(pageUrl), html);
      if (result) ruleName = rule.name;
    } catch {
      result = null;
    }
  }
  if (!result?.contentHtml && opts.contentSelector) {
    const el = doc.querySelector(opts.contentSelector);
    if (el) result = { ...(result || {}), contentHtml: el.innerHTML };
  }
  let readTitle: string | null = null;
  let readByline: string | null = null;
  const institutional = /\.(edu|gov|org|ac)\.cn$|\.edu$/.test(new URL(pageUrl).hostname);
  if (!result?.contentHtml && institutional) {
    const cms = cmsContent(doc);
    if (cms) result = { ...(result || {}), contentHtml: cms };
  }
  if (!result?.contentHtml) {
    // Read before Readability, which rewrites the document.
    const own = markedContent(doc);
    const ownHtml = own?.innerHTML || "";
    const ownText = htmlToText(ownHtml);
    const ownUsable = ownText.length >= MIN_TEXT || /<img/i.test(ownHtml);
    try {
      const article = new Readability(doc as unknown as globalThis.Document, { charThreshold: CHAR_THRESHOLD, keepClasses: false }).parse();
      const picked = article?.content || null;
      const text = htmlToText(picked);
      const footer = isFooter(text);
      // On a short page Readability can pick the footer: every <div> starts at 5 points (an <article> at 0) and
      // paragraphs under 25 characters score nothing, so one address line in a footer <div> beats the text, and when
      // no attempt reaches charThreshold the longest one is returned anyway. So a short pick that strays outside what
      // the page marks as its content gives way to it, a footer always does, and a footer is never kept as the article.
      const unsure = !picked || footer || (text.length < CHAR_THRESHOLD && !linesWithin(text, ownText));
      const contentHtml = unsure && ownUsable ? ownHtml : footer ? null : picked;
      if (contentHtml) {
        result = { ...(result || {}), contentHtml };
        readTitle = article?.title || null;
        readByline = article?.byline || null;
        if (!result.siteName && article?.siteName) result.siteName = article.siteName;
      }
    } catch {
      /* ignore */
    }
  }
  if (!result?.contentHtml) {
    // Readability mutates the document; look for CMS containers in a fresh copy.
    const fresh = parseHTML(html).document;
    normalize(fresh, base);
    const cms = cmsContent(fresh);
    if (cms) result = { ...(result || {}), contentHtml: cms };
  }
  if (!result?.contentHtml) return null;

  const contentHtml = trimArticleHead(sanitize(result.contentHtml, base), [result.title, readTitle, metaTitle]);
  const text = htmlToText(contentHtml);
  if (text.length < MIN_TEXT && !/<img/i.test(contentHtml)) return null;
  const firstImg = contentHtml.match(/<img[^>]+src="([^"]+)"/i)?.[1] || null;
  return {
    title: (result.title || readTitle || metaTitle || "").trim(),
    byline: result.author || readByline || metaAuthor || null,
    siteName: cleanSiteName(result.siteName || metaSite),
    publishedAt: result.publishedAt ?? metaPublished ?? labeledPublished ?? null,
    lang,
    contentHtml,
    text,
    excerpt: makeExcerpt(text, 200),
    leadImage: result.leadImage || metaImage || firstImg,
    wordCount: countWords(text),
    rule: ruleName,
  };
}

/** Minimal metadata when extraction fails (title + description) so captures are never empty. */
export function pageMetadata(html: string, pageUrl: string): { title: string; description: string | null; image: string | null; siteName: string | null } {
  const { document: doc } = parseHTML(html);
  return {
    title: meta(doc, "og:title", "twitter:title") || doc.querySelector("title")?.textContent?.trim() || pageUrl,
    description: meta(doc, "og:description", "description", "twitter:description"),
    image: absolutize(meta(doc, "og:image", "twitter:image"), pageUrl),
    siteName: meta(doc, "og:site_name"),
  };
}

const HEAD_BLOCKS = "h1,h2,h3,h4,h5,h6,p,div,section,li,td,blockquote,figure,header,table,ul,ol";
const META_LINE = /^(发布(时间|日期|者|人)?|发表(时间|日期)|更新(时间|日期)|来源|作者|编辑|责任编辑|审核|撰稿|摄影|供稿|点击(数|量|次数)?|浏览(次数|量|数)?|阅读(次数|量|数)?|访问(量|次数)|字号|字体|分享(到|至)?|打印|关闭|收藏)\s*[:：]?/;
const squash = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");

/** The first thing a reader would see: an image, or the first block with text and no blocks inside. */
function firstVisible(root: Element): Element | null {
  for (const el of root.querySelectorAll("*")) {
    if (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "IFRAME") return el;
    if (!el.matches(HEAD_BLOCKS) || el.querySelector(HEAD_BLOCKS)) continue;
    if ((el.textContent || "").trim()) return el;
  }
  return null;
}

/**
 * Drop page furniture that CMS templates put inside the article container: the title repeated as a heading and the
 * "发布时间 / 点击数 / 分享至" lines under it. Only looks at the top and stops at the first real paragraph or image.
 */
export function trimArticleHead(html: string, titles: (string | null | undefined)[]): string {
  if (!html) return html;
  const { document } = parseHTML(`<!doctype html><html><body><div id="acorn-head-root">${html}</div></body></html>`);
  const root = document.getElementById("acorn-head-root");
  if (!root) return html;
  const names = titles.map((t) => squash(t || "")).filter((t) => t.length >= 4);
  let removed = 0;
  for (let i = 0; i < 8; i++) {
    const el = firstVisible(root);
    if (!el || el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "IFRAME") break;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    const flat = squash(text);
    const heading = /^H[1-6]$/.test(el.tagName);
    const isTitle = names.some((t) => t === flat || (heading && flat.length >= 6 && t.startsWith(flat)));
    const isMeta = text.length <= 80 && (META_LINE.test(text) || /^[\d\s.:：\-/年月日]+$/.test(text));
    if (!isTitle && !isMeta) break;
    // remove the block and any wrappers it leaves empty
    let gone: Element = el;
    while (gone.parentElement && gone.parentElement !== root && !(gone.parentElement.textContent || "").replace(gone.textContent || "", "").trim() && !gone.parentElement.querySelector("img,video,iframe")) {
      gone = gone.parentElement;
    }
    gone.remove();
    removed++;
  }
  return removed ? root.innerHTML : html;
}
