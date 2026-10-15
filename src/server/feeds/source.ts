import type { App } from "../app.ts";
import type { FeedConfig, FeedKind } from "../../shared/types.ts";
import { httpGet, decodeBody, HttpError } from "../util/http.ts";
import { parseFeedText, NotAFeedError, looksLikeHtml, type ParsedItem } from "./parse.ts";
import { scrapeList } from "./html-source.ts";
import { runPlugin } from "./plugins.ts";
import { rsshubUrl } from "./rsshub.ts";
import { parseHTML } from "linkedom";

export interface SourceSpec {
  kind: FeedKind;
  url: string;
  config: FeedConfig;
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
    const r = await runPlugin(app.cfg.pluginsDir, pluginId, config.plugin?.params || {}, config.userAgent || app.cfg.pageUserAgent);
    return { notModified: false, resolvedUrl: `plugin:${pluginId}`, ...r, etag: null, lastModified: null };
  }

  const url = resolveSourceUrl(app, kind, spec.url);
  const isHtml = kind === "html";
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
  if (!res.ok) {
    const body = decodeBody(res.body.subarray(0, 4000), res.contentType).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new HttpError(res.status, res.url, `HTTP ${res.status}${body && body.length < 300 ? `：${body}` : ""}`);
  }
  const text = decodeBody(res.body, res.contentType);
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");

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
    throw err;
  }
}
