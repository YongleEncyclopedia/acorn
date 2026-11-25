/**
 * Site rules: special handling for sites where generic extraction is not good enough.
 * Each rule may provide extraction, a gone-detector and a referer policy for images.
 * To support a new site, add a file here and register it in RULES. Keep rules small and documented.
 */
import { wechat } from "./wechat.ts";
import { zhihu } from "./zhihu.ts";
import { xiaohongshu } from "./xiaohongshu.ts";
import { sspai } from "./sspai.ts";
import { zsxq } from "./zsxq.ts";
import { coverage, decodeEntities, htmlToText } from "../../util/text.ts";

export interface RuleResult {
  /** HTML of the article body (unsanitized; the caller sanitizes). */
  contentHtml?: string;
  title?: string;
  author?: string;
  siteName?: string;
  publishedAt?: number | null;
  leadImage?: string | null;
}

export interface SiteRule {
  name: string;
  match: (url: URL) => boolean;
  extract?: (doc: Document, url: URL, html: string) => RuleResult | null;
  /** Return a reason string when the page says the content is gone. */
  gone?: (html: string, status: number) => string | null;
  /** Return a reason when the page is an anti-bot challenge or login wall rather than the content. */
  blocked?: (html: string, finalUrl: string) => string | null;
  /** Referer to send when downloading images that belong to this site; null = send none. */
  imageReferer?: (pageUrl: string) => string | null;
  /** The site often answers server-side page fetches with a challenge: when the feed carries the article, use it instead of fetching. */
  preferFeedCopy?: boolean;
  /** Repair article links that feeds or bridges mangle; return the fixed URL, or null when it is fine. */
  fixUrl?: (url: URL) => string | null;
}

export const RULES: SiteRule[] = [wechat, zhihu, xiaohongshu, sspai, zsxq];

export function ruleFor(url: string): SiteRule | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return RULES.find((r) => r.match(u)) || null;
}

/** Apply the site rule's link repair, if any. */
export function fixArticleUrl(url: string | null): string | null {
  if (!url) return url;
  const rule = ruleFor(url);
  return (rule?.fixUrl && rule.fixUrl(new URL(url))) || url;
}

/**
 * What sites show in place of a deleted, censored or missing page. A phrase only counts when it is the page's message
 * (see `genericGone`): a notice that opens with 根据相关法律法规, or an essay quoting 该内容已被删除, is still there.
 * They name the page itself (该/此内容, 你访问的页面), so a notice saying 相关内容已被删除 does not match.
 */
const GENERIC_GONE: RegExp[] = [
  /该内容已被发布者删除/,
  /此内容因违规无法查看/,
  /此内容被多人投诉(?:，相关的内容无法进行查看)?/,
  /[该此]文章已被(?:作者)?删除/,
  /[该此]内容已被(?:作者)?删除/,
  /[该此]微博已被(?:作者)?删除/,
  /[你您](?:所|要|想)?访问的页面不存在(?:或已被删除)?/,
  /页面不存在或已被删除/,
  /该内容暂时无法查看/,
  // the censorship notice itself, not every sentence that begins with 根据相关法律法规
  /根据相关法律法规(?:和|及|与)?(?:相关)?政策[，,]?[该此本].{0,8}?(?:不予|未予|无法|暂不|已被)(?:显示|展示|查看|访问|浏览|开放|屏蔽|删除)/,
];

/** Markup that is not page text, links (menus, related lists), and the tags that start a new line. */
const HIDDEN = /<!--[\s\S]*?-->|<(head|script|style|noscript|template|svg|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const LINK = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
const BLOCK =
  /<\/?(?:address|article|aside|blockquote|body|br|button|caption|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

/** A page's title and its visible text outside links, one line per block (paragraph, heading, list item, cell…). */
function pageLines(html: string): { title: string; lines: string[] } {
  const markup = (html.length > 400_000 ? html.slice(0, 400_000) : html).replace(/\s+/g, " ");
  const flat = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return {
    title: flat(markup.match(/<title\b[^>]*>(.*?)<\/title\s*>/i)?.[1] || ""),
    lines: markup.replace(HIDDEN, " ").replace(LINK, " ").replace(BLOCK, "\n").split("\n").map(flat).filter(Boolean),
  };
}

/** The gone phrase a line is about: at least a third of it (抱歉，此微博已被作者删除。查看帮助：), not one clause in a paragraph. */
function goneMessage(line: string): string | null {
  const text = line.replace(/\s/g, "");
  for (const re of GENERIC_GONE) {
    const hit = text.match(re)?.[0];
    if (hit && hit.length * 3 >= text.length) return hit;
  }
  return null;
}

/**
 * The generic check: a phrase from GENERIC_GONE is the page's message (its title, or a heading or line of its own), and
 * outside links, the title and that message the page has next to no text: under 150 characters in sentences (lines
 * with ，。；！？, or of eight words or more) and under 1000 in all. A deletion page is one line in the site's frame
 * (menus, an address and an ICP number in the footer); a live article that quotes the phrase has sentences of its own.
 */
function genericGone(html: string): string | null {
  const { title, lines } = pageLines(html);
  let message = goneMessage(title);
  let prose = 0;
  let rest = 0;
  for (const line of lines) {
    const hit = goneMessage(line);
    if (hit) {
      message ||= hit;
      continue;
    }
    const n = line.replace(/\s/g, "").length;
    rest += n;
    if (/[，。；！？]/.test(line) || (line.match(/[A-Za-z]+/g)?.length ?? 0) >= 8) prose += n;
    if (prose >= 150 || rest >= 1000) return null;
  }
  return message;
}

/** The page still shows at least half of a text we archived from it (of 50 characters or more; less is too little to tell). */
export function stillShows(html: string, known: string): boolean {
  return known.replace(/\s+/g, "").length >= 50 && coverage(known, htmlToText(html)) >= 0.5;
}

/**
 * Is the page gone (deleted, censored, never there)? Returns the reason, or null. HTTP 404/410/451 settle it; otherwise
 * the site's rule and then the generic phrases read the page. `known` is text we already hold for this page (the latest
 * snapshot, or the feed's copy): a page that still shows half of it or more has not gone, whatever phrase it contains.
 */
export function detectGone(url: string, html: string, status: number, known?: string | null): string | null {
  if (status === 404 || status === 410 || status === 451) return `HTTP ${status}`;
  const reason = ruleFor(url)?.gone?.(html, status) || genericGone(html);
  if (reason && known && stillShows(html, known)) return null;
  return reason;
}

const GENERIC_BLOCK: [RegExp, string][] = [
  [/wappoc_appmsgcaptcha|poc_token/, "微信要求人机验证（环境异常）"],
  [/\/account\/unhuman|zse-ck|安全验证/, "知乎要求安全验证"],
  [/website-login\/captcha|xhs-captcha|验证码/, "小红书要求验证"],
  [/passport\.weibo\.(com|cn)\/visitor/, "微博要求访客验证"],
  [/cf-chl-bypass|challenge-platform|Just a moment\.\.\./, "网站开启了 Cloudflare 人机验证"],
];

/** Detect anti-bot challenges / login walls so captures can explain what happened instead of saving junk. */
export function detectBlocked(url: string, html: string): string | null {
  const rule = ruleFor(url);
  const specific = rule?.blocked?.(html, url);
  if (specific) return specific;
  const sample = `${url}\n${html.slice(0, 60_000)}`;
  if (html.length > 200_000 && !/captcha|验证/.test(sample)) return null;
  for (const [re, reason] of GENERIC_BLOCK) if (re.test(sample)) return reason;
  return null;
}
