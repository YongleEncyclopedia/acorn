import type { App } from "../app.ts";
import type { FeedConfig, FeedKind } from "../../shared/types.ts";
import { httpGet, decodeBody, HttpError, BotCheckError, botCheck } from "../util/http.ts";
import { browserRead } from "./browser-read.ts";
import { parseFeedText, NotAFeedError, looksLikeHtml, type ParsedItem } from "./parse.ts";
import { scrapeList } from "./html-source.ts";
import { runPlugin } from "./plugins.ts";
import { LoginExpiredError } from "./plugin-api.ts";
import { accountFor, keepRenewed } from "../accounts/use.ts";
import { rsshubUrl } from "./rsshub.ts";
import { parseHTML } from "linkedom";

export interface SourceSpec {
  kind: FeedKind;
  url: string;
  config: FeedConfig;
  /** The subscription being refreshed: a plugin keeps its state under it. Absent in previews. */
  feedId?: number;
  etag?: string | null;
  lastModified?: string | null;
}

export interface SourceResult {
  notModified: boolean;
  resolvedUrl: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  /** Channel image (RSS <image>, Atom logo/icon, JSON Feed icon). */
  image?: string | null;
  items: ParsedItem[];
  etag: string | null;
  lastModified: string | null;
  /** Raw body when the URL turned out to be an HTML page (used for discovery). */
  html?: string;
}

const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

export function rsshubBase(app: App): string {
  return app.settings.all().rsshubBase || app.cfg.rsshubBase;
}

export function resolveSourceUrl(app: App, kind: FeedKind, url: string): string {
  if (kind === "rsshub") return rsshubUrl(url, rsshubBase(app), app.settings.all().rsshubKey || app.cfg.rsshubKey);
  return url;
}

/** Fetch any kind of source and return normalized items. Throws on network/parse errors. */
export async function fetchSource(app: App, spec: SourceSpec): Promise<SourceResult> {
  const { kind, config } = spec;
  if (kind === "plugin") {
    const pluginId = config.plugin?.id || spec.url;
    const account = await accountFor(app, pluginId, config.plugin?.account);
    const jarBefore = JSON.stringify(account?.jar);
    try {
      const state = spec.feedId ? app.feeds.state(spec.feedId) : undefined;
      const r = await runPlugin(app.cfg.pluginsDir, pluginId, config.plugin?.params || {}, config.userAgent || app.cfg.pageUserAgent, account, state);
      keepRenewed(app, account, jarBefore);
      if (account) app.accounts.markWorking(account.id);
      return { notModified: false, resolvedUrl: `plugin:${pluginId}`, ...r, etag: null, lastModified: null };
    } catch (err) {
      // the platform refused the sign-in: every subscription using it waits for a new one (设置 → 账号)
      if (err instanceof LoginExpiredError && account) {
        const msg = /重新登录/.test(err.message) ? err.message : `${err.message}，请在 设置 → 账号 里重新登录`;
        app.accounts.setStatus(account.id, "expired", msg);
        throw new LoginExpiredError(msg);
      }
      throw err;
    }
  }

  const url = resolveSourceUrl(app, kind, spec.url);
  const isHtml = kind === "html";
  // through the user's browser: a feed as it is served, a page as its scripts leave it
  if (config.browser) {
    const r = await browserRead(app, url, isHtml ? "rendered" : "raw");
    return parsed(app, kind, url, config, r.text, r.url, null, null);
  }
  const res = await httpGet(url, {
    etag: isHtml ? null : spec.etag,
    lastModified: isHtml ? null : spec.lastModified,
    userAgent: config.userAgent || (isHtml ? app.cfg.pageUserAgent : app.cfg.feedUserAgent),
    accept: isHtml ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" : FEED_ACCEPT,
    headers: config.headers,
    cookie: config.cookie,
    timeoutMs: kind === "rsshub" ? 60_000 : 30_000,
  });
  if (res.notModified) {
    return { notModified: true, resolvedUrl: res.url, title: "", siteUrl: null, description: null, items: [], etag: spec.etag || null, lastModified: spec.lastModified || null };
  }
  const vendor = botCheck(res);
  if (vendor) throw new BotCheckError(res.status, res.url, vendor);
  if (!res.ok) {
    const body = decodeBody(res.body.subarray(0, 4000), res.contentType).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new HttpError(res.status, res.url, `HTTP ${res.status}${body && body.length < 300 ? `：${body}` : ""}`);
  }
  return parsed(app, kind, url, config, decodeBody(res.body, res.contentType), res.url, res.headers.get("etag"), res.headers.get("last-modified"));
}

/** A fetched source's text, read as a list page or a feed. */
function parsed(app: App, kind: FeedKind, url: string, config: FeedConfig, text: string, finalUrl: string, etag: string | null, lastModified: string | null): SourceResult {
  const res = { url: finalUrl };
  const isHtml = kind === "html";
  if (isHtml) {
    if (!config.html?.item) throw new Error("网页源缺少列表选择器（config.html.item）");
    const { document } = parseHTML(text);
    const title = document.querySelector("title")?.textContent?.trim() || res.url;
    return { notModified: false, resolvedUrl: res.url, title, siteUrl: res.url, description: null, items: scrapeList(text, res.url, config.html), etag: null, lastModified: null };
  }
  try {
    const feed = parseFeedText(text, res.url);
    return { notModified: false, resolvedUrl: res.url, title: feed.title, siteUrl: feed.siteUrl, description: feed.description, image: feed.image, items: feed.items, etag, lastModified };
  } catch (err) {
    if (err instanceof NotAFeedError && looksLikeHtml(text)) {
      const e = new NotAFeedError(err.message) as NotAFeedError & { html?: string; finalUrl?: string };
      e.html = text;
      e.finalUrl = res.url;
      throw e;
    }
    // JSON that is not a JSON Feed: an API, which the json source can read (builtin/json.ts)
    if (err instanceof NotAFeedError && /^\s*[[{]/.test(text)) {
      const e = new NotAFeedError("这是一个 JSON 接口，不是订阅源") as NotAFeedError & { json?: string; finalUrl?: string };
      e.json = text;
      e.finalUrl = res.url;
      throw e;
    }
    throw err;
  }
}
