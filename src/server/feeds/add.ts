import type { App } from "../app.ts";
import type { FeedConfig, FeedKind, FeedPreview, FullTextMode, PreviewItem } from "../../shared/types.ts";
import { fetchSource, rsshubBase, type SourceResult } from "./source.ts";
import { parseRsshubInput } from "./rsshub.ts";
import { NotAFeedError, parseFeedText } from "./parse.ts";
import { discoverFeeds, guessFeedUrls } from "./discover.ts";
import { scrapeList, suggestRule } from "./html-source.ts";
import { refreshFeed } from "./refresh.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { excerpt, htmlToText } from "../util/text.ts";
import type { FeedInternal } from "../store/feeds.ts";

export interface SourceInput {
  input: string;
  kind?: FeedKind;
  config?: FeedConfig;
}

export interface AddFeedInput extends SourceInput {
  title?: string;
  folderId?: number | null;
  folderName?: string;
  fullText?: FullTextMode;
  autoArchive?: boolean;
  fetchInterval?: number | null;
}

export class SourceChoiceError extends Error {
  preview: FeedPreview;
  constructor(message: string, preview: FeedPreview) {
    super(message);
    this.preview = preview;
  }
}

function toPreviewItems(res: Pick<SourceResult, "items">): PreviewItem[] {
  return res.items.slice(0, 12).map((it) => ({
    title: it.title,
    url: it.url,
    publishedAt: it.publishedAt,
    summary: excerpt(htmlToText(it.summary || it.contentHtml), 140) || null,
    image: it.image,
  }));
}

/** Normalize what the user typed: rsshub:// routes, bare domains, plugin:id. */
export function classifyInput(app: App, raw: string, kind?: FeedKind): { kind: FeedKind; url: string } {
  const input = raw.trim();
  if (kind === "plugin" || input.startsWith("plugin:")) return { kind: "plugin", url: input.replace(/^plugin:/, "") };
  const route = kind === "rsshub" ? parseRsshubInput(input.startsWith("/") ? `rsshub:/${input}` : input, [rsshubBase(app)]) : parseRsshubInput(input, [rsshubBase(app)]);
  if (route && kind !== "html" && kind !== "feed") return { kind: "rsshub", url: route };
  let url = input;
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, "")}`;
  return { kind: kind === "html" ? "html" : "feed", url };
}

/** Fetch a source without saving it: feed items, or discovered feeds / a suggested HTML rule for web pages. */
export async function previewSource(app: App, src: SourceInput): Promise<FeedPreview> {
  const { kind, url } = classifyInput(app, src.input, src.kind);
  const config = src.config || {};
  const base: FeedPreview = { kind, url, resolvedUrl: url, title: "", siteUrl: null, description: null, items: [], candidates: [], suggestedRule: null };

  if (kind === "plugin" || kind === "rsshub" || (kind === "html" && config.html?.item)) {
    const res = await fetchSource(app, { kind, url, config: kind === "plugin" ? { ...config, plugin: { id: url, params: config.plugin?.params || {} } } : config });
    return { ...base, resolvedUrl: res.resolvedUrl, title: res.title, siteUrl: res.siteUrl, description: res.description, items: toPreviewItems(res), suggestedRule: config.html || null };
  }

  if (kind === "html") {
    const res = await httpGet(url, { userAgent: app.cfg.pageUserAgent, accept: "text/html" });
    const html = decodeBody(res.body, res.contentType);
    const rule = suggestRule(html, res.url);
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || res.url;
    return { ...base, resolvedUrl: res.url, title, siteUrl: res.url, suggestedRule: rule, items: rule ? toPreviewItems({ items: scrapeList(html, res.url, rule) }) : [] };
  }

  try {
    const res = await fetchSource(app, { kind: "feed", url, config });
    return { ...base, resolvedUrl: res.resolvedUrl, title: res.title, siteUrl: res.siteUrl, description: res.description, items: toPreviewItems(res) };
  } catch (err) {
    const e = err as NotAFeedError & { html?: string; finalUrl?: string };
    if (!(err instanceof NotAFeedError) || !e.html) throw err;
    const pageUrl = e.finalUrl || url;
    const candidates: FeedPreview["candidates"] = discoverFeeds(e.html, pageUrl);
    const rule = suggestRule(e.html, pageUrl);
    if (!candidates.length) {
      // Probe well-known feed paths. These are site-wide guesses, so they only win when the page itself has no list.
      const probes = await Promise.allSettled(
        guessFeedUrls(pageUrl).map(async (u) => {
          const r = await httpGet(u, { userAgent: app.cfg.feedUserAgent, timeoutMs: 10_000, maxBytes: 5_000_000 });
          if (!r.ok) throw new Error("no");
          const parsed = parseFeedText(decodeBody(r.body, r.contentType), r.url);
          return { url: r.url, title: parsed.title, kind: "feed" as FeedKind, guessed: true };
        }),
      );
      for (const p of probes) if (p.status === "fulfilled" && !candidates.some((c) => c.url === p.value.url)) candidates.push(p.value);
    }
    const declared = candidates.filter((c) => !c.guessed);
    const useHtml = !declared.length && !!rule;
    const title = e.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || pageUrl;
    return {
      ...base,
      kind: useHtml || !candidates.length ? "html" : "feed",
      url: pageUrl,
      resolvedUrl: pageUrl,
      title,
      siteUrl: pageUrl,
      candidates,
      suggestedRule: rule,
      items: useHtml && rule ? toPreviewItems({ items: scrapeList(e.html, pageUrl, rule) }) : [],
    };
  }
}

/** Subscribe. Web pages with exactly one feed are followed automatically; ambiguous pages raise SourceChoiceError. */
export async function addFeed(app: App, input: AddFeedInput): Promise<{ feed: FeedInternal; existed: boolean; added: number; error?: string }> {
  let { kind, url } = classifyInput(app, input.input, input.kind);
  let config: FeedConfig = input.config || {};
  if (kind === "plugin") config = { ...config, plugin: { id: url, params: config.plugin?.params || {} } };

  if (kind === "feed" && !input.kind) {
    const preview = await previewSource(app, { input: url, kind: "feed", config });
    const declared = preview.candidates.filter((c) => !c.guessed);
    if (declared.length === 1) url = declared[0].url;
    else if (declared.length > 1) throw new SourceChoiceError("这个网页提供了多个订阅源，请选择一个", preview);
    else if (preview.kind === "html" && preview.suggestedRule) {
      kind = "html";
      config = { ...config, html: preview.suggestedRule };
    } else if (preview.candidates.length === 1) url = preview.candidates[0].url;
    else if (preview.candidates.length > 1) throw new SourceChoiceError("这个网站提供了多个订阅源，请选择一个", preview);
    else if (preview.kind === "html") throw new SourceChoiceError("这是一个网页，没有找到订阅源，也没能识别出文章列表", preview);
    else url = preview.resolvedUrl || url;
  }
  if (kind === "html" && !config.html?.item) {
    const preview = await previewSource(app, { input: url, kind: "html" });
    if (!preview.suggestedRule) throw new SourceChoiceError("没能识别出文章列表，请手动填写选择器", preview);
    config = { ...config, html: preview.suggestedRule };
  }

  const existing = app.feeds.find(kind, url);
  if (existing) return { feed: existing, existed: true, added: 0 };
  let folderId = input.folderId ?? null;
  if (!folderId && input.folderName?.trim()) folderId = app.feeds.createFolder(input.folderName).id;
  const feed = app.feeds.create({
    kind,
    url,
    customTitle: input.title?.trim() || null,
    folderId,
    config,
    fullText: input.fullText,
    autoArchive: input.autoArchive,
    fetchInterval: input.fetchInterval ?? null,
  });
  const r = await refreshFeed(app, feed.id);
  app.events.emit({ type: "counts" });
  return { feed: app.feeds.get(feed.id)!, existed: false, added: r.added, error: r.error };
}
