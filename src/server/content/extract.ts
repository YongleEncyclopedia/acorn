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

export interface ExtractOptions {
  /** Feed-specific CSS selector for the article body. */
  contentSelector?: string;
}

/**
 * Turn a full HTML page into a clean article. Order: site rule → explicit selector → Readability.
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
    try {
      const article = new Readability(doc as unknown as globalThis.Document, { charThreshold: 140, keepClasses: false }).parse();
      if (article?.content) {
        result = { ...(result || {}), contentHtml: article.content };
        readTitle = article.title || null;
        readByline = article.byline || null;
        if (!result.siteName && article.siteName) result.siteName = article.siteName;
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

  const contentHtml = sanitize(result.contentHtml, base);
  const text = htmlToText(contentHtml);
  if (text.length < 30 && !/<img/i.test(contentHtml)) return null;
  const firstImg = contentHtml.match(/<img[^>]+src="([^"]+)"/i)?.[1] || null;
  return {
    title: (result.title || readTitle || metaTitle || "").trim(),
    byline: result.author || readByline || metaAuthor || null,
    siteName: cleanSiteName(result.siteName || metaSite),
    publishedAt: result.publishedAt ?? metaPublished ?? null,
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
