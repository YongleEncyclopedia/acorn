import type { App } from "../app.ts";
import type { FeedConfig, FeedKind, FeedPreview, FullTextMode, PreviewItem } from "../../shared/types.ts";
import { fetchSource, rsshubBase, type SourceResult } from "./source.ts";
import { getPlugin } from "./plugins.ts";
import type { AcornPlugin } from "./plugin-api.ts";
import { parseRsshubInput } from "./rsshub.ts";
import { NotAFeedError, looksLikeHtml, parseFeedText } from "./parse.ts";
import { discoverFeeds, feedLinks, guessFeedUrls } from "./discover.ts";
import { siteFeeds } from "./hints.ts";
import { radarFor } from "./radar.ts";
import { browserDiscover } from "./browser-read.ts";
import { jsonItems, suggestJsonRule } from "./builtin/json.ts";
import { parseLooseDate } from "../util/dates.ts";
import { scrapeList, suggestRule } from "./html-source.ts";
import { refreshFeed } from "./refresh.ts";
import { httpGet, decodeBody, botCheck } from "../util/http.ts";
import { excerpt, htmlToText, randomToken } from "../util/text.ts";
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
    const res = await fetchSource(app, { kind, url, config: kind === "plugin" ? { ...config, plugin: { ...config.plugin, id: url, params: config.plugin?.params || {} } } : config });
    return { ...base, resolvedUrl: res.resolvedUrl, title: res.title, siteUrl: res.siteUrl, description: res.description, items: toPreviewItems(res), suggestedRule: config.html || null };
  }

  if (kind === "html") {
    const res = await httpGet(url, { userAgent: app.cfg.pageUserAgent, accept: "text/html" });
    const html = decodeBody(res.body, res.contentType);
    const rule = suggestRule(html, res.url);
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || res.url;
    return { ...base, resolvedUrl: res.url, title, siteUrl: res.url, suggestedRule: rule, items: rule ? toPreviewItems({ items: scrapeList(html, res.url, rule) }) : [] };
  }

  // RSSHub's routes for the address are looked up meanwhile: they serve platforms that block servers or have no feed
  const routes = radarFor(app, url);
  if (config.browser) return { ...(await discoverInBrowser(app, url, base)), rsshub: await routes };
  try {
    const res = await fetchSource(app, { kind: "feed", url, config });
    return { ...base, resolvedUrl: res.resolvedUrl, title: res.title, siteUrl: res.siteUrl, description: res.description, items: toPreviewItems(res) };
  } catch (err) {
    const e = err as NotAFeedError & { html?: string; json?: string; finalUrl?: string };
    if (err instanceof NotAFeedError && e.json) return { ...previewJson(base, e.finalUrl || url, e.json), rsshub: await routes };
    if (!(err instanceof NotAFeedError) || !e.html) {
      // The address itself could not be read (blocked, a bot check, offline). RSSHub or the site's own feeds may still do.
      const rsshub = await routes;
      const hinted = await probeFeeds(app, siteFeeds(url));
      if (rsshub.length || hinted.length) return { ...base, kind: hinted.length ? "feed" : "html", candidates: hinted, rsshub, problem: (err as Error).message };
      throw err;
    }
    const pageUrl = e.finalUrl || url;
    const candidates: FeedPreview["candidates"] = await checkDeclared(app, discoverFeeds(e.html, pageUrl));
    const rule = suggestRule(e.html, pageUrl);
    // The site's own patterns (GitHub releases…) and links that say RSS, kept once read as feeds; the usual paths
    // only when nothing else turned up, since they are site-wide guesses.
    const known = new Set(candidates.map((c) => c.url));
    candidates.push(...(await probeFeeds(app, [...siteFeeds(pageUrl), ...feedLinks(e.html, pageUrl)].filter((c) => !known.has(c.url)), { follow: true })));
    if (!candidates.length) candidates.push(...(await probeFeeds(app, guessFeedUrls(pageUrl).map((u) => ({ url: u, title: "" })), { guessed: true })));
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
      candidates: dedupe(candidates),
      suggestedRule: rule,
      items: useHtml && rule ? toPreviewItems({ items: scrapeList(e.html, pageUrl, rule) }) : [],
      rsshub: await routes,
    };
  }
}

/**
 * The feeds a page declares, read once: sites keep announcing feeds they no longer serve (WordPress with its feeds
 * turned off answers them empty). One that answers with something other than a feed is dropped, so the page's own
 * list is used instead; one that could not be read at all stays, as before.
 */
async function checkDeclared(app: App, list: FeedPreview["candidates"]): Promise<FeedPreview["candidates"]> {
  const checked = await Promise.all(
    list.slice(0, 12).map(async (c) => {
      try {
        const r = await httpGet(c.url, { userAgent: app.cfg.feedUserAgent, timeoutMs: 10_000, maxBytes: 5_000_000 });
        // gone or refused for good (WordPress answers its locked JSON interface 401); a bot check (403, 429) may hide a feed
        if (!r.ok) return [401, 404, 410].includes(r.status) ? null : c;
        return FEEDLIKE.test(decodeBody(r.body, r.contentType).slice(0, 2000)) ? c : null;
      } catch {
        return c;
      }
    }),
  );
  return [...checked.filter((c) => c !== null), ...list.slice(12)];
}

const dedupe = (list: FeedPreview["candidates"]) => list.filter((c, i) => list.findIndex((d) => d.url === c.url) === i);

const FEEDLIKE = /^\s*(<\?xml[^>]*>\s*)?(<\?xml-stylesheet[^>]*>\s*)*(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b|"version"\s*:\s*"https:\/\/jsonfeed\.org/i;

/**
 * Addresses read to see whether they are feeds. A link that turns out to be a page listing feeds (an "RSS"
 * page) is followed once (`follow`).
 */
async function probeFeeds(app: App, list: { url: string; title: string }[], opts: { guessed?: boolean; follow?: boolean } = {}): Promise<FeedPreview["candidates"]> {
  const out: FeedPreview["candidates"] = [];
  const next: { url: string; title: string }[] = [];
  await Promise.allSettled(
    list.slice(0, 12).map(async (c) => {
      const r = await httpGet(c.url, { userAgent: app.cfg.feedUserAgent, timeoutMs: 10_000, maxBytes: 5_000_000 });
      if (!r.ok) return;
      const text = decodeBody(r.body, r.contentType);
      if (FEEDLIKE.test(text.slice(0, 2000))) {
        const parsed = parseFeedText(text, r.url);
        out.push({ url: r.url, title: parsed.title || c.title, kind: "feed", ...(opts.guessed ? { guessed: true } : {}) });
      } else if (opts.follow && looksLikeHtml(text)) {
        for (const d of discoverFeeds(text, r.url)) next.push({ url: d.url, title: d.title });
        for (const l of feedLinks(text, r.url)) if (/\.(xml|rss|atom)(\?|$)|\/(rss|feed|atom)\/?(\?|$)/i.test(l.url)) next.push(l);
      }
    }),
  );
  const seen = new Set([...list.map((c) => c.url), ...out.map((c) => c.url)]);
  if (next.length) out.push(...(await probeFeeds(app, next.filter((c) => !seen.has(c.url)), { guessed: opts.guessed })));
  return out;
}

/** An address that answers JSON: the json source, with the mapping worked out from the answer. */
function previewJson(base: FeedPreview, url: string, text: string): FeedPreview {
  const site = new URL(url).origin;
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ...base, kind: "html", problem: "这个地址返回的内容不是有效的 JSON" };
  }
  const rule = suggestJsonRule(data);
  const items = rule ? jsonItems(data, rule, site, parseLooseDate) : [];
  return {
    ...base,
    kind: "plugin",
    url: "json",
    resolvedUrl: url,
    title: new URL(url).host,
    siteUrl: site,
    json: { url, ...(rule || {}) },
    items: items.slice(0, 12).map((it) => ({ title: it.title, url: it.url, publishedAt: it.publishedAt, summary: excerpt(htmlToText(it.content), 140) || null, image: it.image })),
    ...(rule ? {} : { problem: "没能在这个 JSON 里认出条目列表，可以在下面手动填写字段" }),
  };
}

/**
 * The page as the user's browser sees it: feeds only the browser can read (past a bot check), the JSON its
 * scripts load, or its list once rendered. What the server can read by itself is subscribed without the browser.
 */
async function discoverInBrowser(app: App, url: string, base: FeedPreview): Promise<FeedPreview> {
  const finds = await browserDiscover(app, url);
  const title = finds.title || new URL(finds.finalUrl).host;
  const page = { ...base, url: finds.finalUrl, resolvedUrl: finds.finalUrl, title, siteUrl: finds.finalUrl, browser: true };
  const serverReads = async (u: string) => {
    try {
      const r = await httpGet(u, { userAgent: app.cfg.feedUserAgent, timeoutMs: 10_000, maxBytes: 5_000_000 });
      return r.ok && !botCheck(r);
    } catch {
      return false;
    }
  };
  const feeds: FeedPreview["candidates"] = [];
  for (const f of finds.feeds) {
    try {
      const parsed = parseFeedText(f.text, f.url);
      feeds.push({ url: f.url, title: parsed.title, kind: "feed", ...((await serverReads(f.url)) ? {} : { browser: true }) });
    } catch {
      /* not a feed after all */
    }
  }
  if (feeds.length === 1) {
    const parsed = parseFeedText(finds.feeds.find((f) => f.url === feeds[0].url)!.text, feeds[0].url);
    return { ...page, kind: "feed", url: feeds[0].url, resolvedUrl: feeds[0].url, title: parsed.title || title, browser: !!feeds[0].browser, items: toPreviewItems(parsed) };
  }
  if (feeds.length) return { ...page, kind: "feed", candidates: feeds };
  // the JSON with the most articles in it, if the server can fetch it too
  let api: { preview: FeedPreview; n: number } | null = null;
  for (const j of finds.json) {
    const p = previewJson(base, j.url, j.text);
    if (p.json && !p.problem && p.items.length > (api?.n ?? 2)) api = { preview: p, n: p.items.length };
  }
  if (api && (await serverReads(api.preview.resolvedUrl))) return { ...api.preview, problem: undefined };
  const rule = suggestRule(finds.html, finds.finalUrl);
  if (rule) return { ...page, kind: "html", suggestedRule: rule, items: toPreviewItems({ items: scrapeList(finds.html, finds.finalUrl, rule) }) };
  return { ...page, kind: "html", problem: "在浏览器里也没找到订阅源、数据接口或文章列表。可以改成「监控网页变化」" };
}

/**
 * A plugin subscription's address: its id and parameters, which tells two subscriptions of one plugin apart (two
 * 星球). Secret parameters (a push key) are left out: the address shows in lists and exports.
 */
export function pluginAddress(id: string, params: Record<string, string>, plugin: Pick<AcornPlugin, "params"> | null): string {
  const secret = new Set((plugin?.params || []).filter((p) => p.secret).map((p) => p.key));
  const shown = Object.entries(params).filter(([k, v]) => v !== "" && !secret.has(k));
  return shown.length ? `${id}?${new URLSearchParams(shown.sort(([a], [b]) => a.localeCompare(b))).toString()}` : id;
}

/** Subscribe. Web pages with exactly one feed are followed automatically; ambiguous pages raise SourceChoiceError. */
export async function addFeed(app: App, input: AddFeedInput): Promise<{ feed: FeedInternal; existed: boolean; added: number; error?: string }> {
  let { kind, url } = classifyInput(app, input.input, input.kind);
  let config: FeedConfig = input.config || {};
  if (kind === "plugin") config = { ...config, plugin: { ...config.plugin, id: url, params: config.plugin?.params || {} } };

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

  // A plugin is subscribed once per set of parameters (two 星球, Canvas announcements and to-dos): its address
  // carries them, since a subscription's address is unique. Its id stays in config.plugin.
  let fullText = input.fullText;
  let fetchInterval = input.fetchInterval ?? null;
  if (kind === "plugin") {
    const plugin = await getPlugin(app.cfg.pluginsDir, config.plugin!.id).catch(() => null);
    // values Acorn makes up (a push address's id and key) are filled in now
    const params = { ...(config.plugin?.params || {}) };
    for (const p of plugin?.params || []) if (p.generate && !params[p.key]) params[p.key] = randomToken(p.secret ? 18 : 6);
    config = { ...config, plugin: { ...config.plugin!, params } };
    url = pluginAddress(config.plugin!.id, params, plugin);
    // platforms behind a sign-in hand over whole articles, and their pages show nothing to a server without it
    if (plugin?.account) fullText = "never";
    // a push subscription has nothing to fetch; messages arrive at its address
    if (plugin?.id === "inbox") {
      fullText = "never";
      fetchInterval = 10080;
    }
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
    fullText,
    autoArchive: input.autoArchive,
    fetchInterval,
  });
  const r = await refreshFeed(app, feed.id);
  // A notice page keeps months of old items: only the last two weeks (or, without dates, nothing) start out unread.
  // Plugins are lists of notices and posts too (a semester of course announcements, a 星球's history).
  if (kind === "html" || kind === "plugin") {
    const dated = !!app.db.get("select 1 from entries where feed_id = ? and published_at is not null limit 1", feed.id);
    app.entries.markRead({ feedId: feed.id, before: dated ? Date.now() - 14 * 86_400_000 : Date.now() });
  }
  app.events.emit({ type: "counts" });
  return { feed: app.feeds.get(feed.id)!, existed: false, added: r.added, error: r.error };
}
