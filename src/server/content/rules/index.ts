/**
 * Site rules: special handling for sites where generic extraction is not good enough.
 * Each rule may provide extraction, a gone-detector and a referer policy for images.
 * To support a new site, add a file here and register it in RULES. Keep rules small and documented.
 */
import { wechat } from "./wechat.ts";
import { zhihu } from "./zhihu.ts";
import { xiaohongshu } from "./xiaohongshu.ts";
import { sspai } from "./sspai.ts";

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

export const RULES: SiteRule[] = [wechat, zhihu, xiaohongshu, sspai];

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

const GENERIC_GONE = [
  "该内容已被发布者删除",
  "此内容因违规无法查看",
  "此内容被多人投诉",
  "该文章已被删除",
  "内容已被删除",
  "该微博已被删除",
  "抱歉，此微博已被作者删除",
  "你访问的页面不存在",
  "页面不存在或已被删除",
  "该内容暂时无法查看",
  "根据相关法律法规",
];

/** Generic detector used for every site after site-specific rules. */
export function detectGone(url: string, html: string, status: number): string | null {
  if (status === 404 || status === 410 || status === 451) return `HTTP ${status}`;
  const rule = ruleFor(url);
  const specific = rule?.gone?.(html, status);
  if (specific) return specific;
  const head = html.length > 400_000 ? html.slice(0, 400_000) : html;
  const text = head.replace(/<[^>]+>/g, " ");
  if (text.length < 6000) {
    const hit = GENERIC_GONE.find((p) => text.includes(p));
    if (hit) return hit;
  }
  return null;
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
