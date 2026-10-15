import type { App } from "../app.ts";
import type { FeedInternal } from "../store/feeds.ts";
import type { IncomingItem } from "../store/entries.ts";
import type { ParsedItem } from "./parse.ts";
import { fetchSource } from "./source.ts";
import { sanitize } from "../content/sanitize.ts";
import { countWords, excerpt, htmlToText } from "../util/text.ts";
import { absolutize, hostOf } from "../util/url.ts";
import { fetchFullText } from "../content/fulltext.ts";
import { fixArticleUrl, ruleFor } from "../content/rules/index.ts";
import { archiveEntry } from "../archive/capture.ts";
import { fetchIcon } from "./icons.ts";
import { logger } from "../util/log.ts";

const log = logger("refresh");
const MAX_ITEMS = 300;

const TEASER = /(查看全文|阅读全文|阅读原文|点击查看|继续阅读|read more|continue reading|\[(…|\.\.\.)\]|…\s*$|\.\.\.\s*$)/i;

/** Should we fetch the article page to get the full text? */
export function needsFullText(item: IncomingItem): boolean {
  if (!item.url) return false;
  const text = htmlToText(item.content);
  if (text.length < 280) return true;
  if (item.wordCount < 120) return true;
  return TEASER.test(text.slice(-80));
}

export function toIncoming(it: ParsedItem, base: string): IncomingItem {
  const contentHtml = sanitize(it.contentHtml, it.url || base);
  const text = htmlToText(contentHtml);
  const summarySource = (it.summary ? htmlToText(it.summary) : text).replace(/\s*(查看全文|阅读全文|阅读原文|点击查看|继续阅读|read more|continue reading)\s*[>›»…]*\s*$/i, "");
  return {
    guid: it.guid,
    url: fixArticleUrl(it.url),
    title: (it.title || "").replace(/\s+/g, " ").trim().slice(0, 500) || excerpt(text, 60) || "（无标题）",
    author: it.author ? it.author.slice(0, 200) : null,
    content: contentHtml || null,
    summary: excerpt(summarySource, 240) || null,
    image: absolutize(it.image, it.url || base),
    publishedAt: it.publishedAt,
    wordCount: countWords(text),
  };
}

function samePath(a: string, b: string): boolean {
  try {
    const pa = new URL(a).pathname;
    return pa.length > 1 && pa === new URL(b).pathname;
  } catch {
    return false;
  }
}

function nextFetchAt(app: App, feed: FeedInternal, failed: boolean): number {
  const base = (feed.fetchInterval || app.settings.all().defaultInterval) * 60_000;
  const jitter = 1 + (Math.random() * 0.2 - 0.1);
  if (!failed) return Date.now() + base * jitter;
  const backoff = Math.min(base * 2 ** Math.min(feed.errorCount + 1, 6), 24 * 3_600_000);
  return Date.now() + backoff * jitter;
}

export interface RefreshResult {
  added: number;
  notModified?: boolean;
  error?: string;
}

/** Fetch one feed, store new entries, and queue follow-up work (full text, auto-archive, icon). */
export async function refreshFeed(app: App, feedId: number): Promise<RefreshResult> {
  const feed = app.feeds.get(feedId);
  if (!feed) return { added: 0, error: "订阅源不存在" };
  const started = Date.now();
  try {
    const res = await fetchSource(app, { kind: feed.kind, url: feed.url, config: feed.config, etag: feed.etag, lastModified: feed.lastModified });
    if (res.notModified) {
      app.feeds.recordSuccess(feed.id, Date.now(), nextFetchAt(app, feed, false), res.etag, res.lastModified);
      app.feeds.log(feed.id, { at: started, status: "not_modified", added: 0, ms: Date.now() - started, error: null });
      app.events.emit({ type: "feed", feedId: feed.id, ok: true });
      return { added: 0, notModified: true };
    }
    const base = res.siteUrl || res.resolvedUrl;
    const items = res.items.slice(0, MAX_ITEMS).map((it) => toIncoming(it, base));
    const { added, grown } = app.entries.upsert(feed.id, items);
    const patch: Parameters<typeof app.feeds.update>[1] = {};
    if (res.title && res.title !== feed.originalTitle) patch.title = res.title;
    if (res.siteUrl && res.siteUrl !== feed.siteUrl) patch.siteUrl = res.siteUrl;
    if (res.description && !feed.description) patch.description = res.description.slice(0, 500);
    if (Object.keys(patch).length) app.feeds.update(feed.id, patch);
    app.feeds.recordSuccess(feed.id, Date.now(), nextFetchAt(app, feed, false), res.etag, res.lastModified);
    app.feeds.log(feed.id, { at: started, status: "ok", added: added.length, ms: Date.now() - started, error: null });

    if (added.length) {
      const byId = new Map(items.map((it) => [it.guid, it]));
      for (const id of added) {
        const row = app.entries.row(id);
        if (!row) continue;
        const incoming = byId.get(row.guid);
        const want = feed.fullText === "always" || (feed.fullText === "auto" && incoming && needsFullText(incoming));
        // Sites like WeChat often answer with a captcha: when the feed already has the body, don't fetch the page.
        const useFeedCopy = !!row.url && !!ruleFor(row.url)?.preferFeedCopy && (incoming?.wordCount ?? 0) >= 200;
        if (want && row.url && !useFeedCopy) app.jobs.add(`fulltext:${id}`, hostOf(row.url), () => fetchFullText(app, id).then(() => undefined), -1);
        if (feed.autoArchive && row.url) app.jobs.add(`archive:entry:${id}`, hostOf(row.url), () => archiveEntry(app, id, "fetch").then(() => undefined), -2);
      }
      app.events.emit({ type: "entries", feedId: feed.id, added: added.length });
    }
    // Bridges (we-mp-rss) list articles first and fill in the body later; archive again once it arrives.
    if (feed.autoArchive) {
      for (const id of grown) {
        const url = app.entries.row(id)?.url;
        if (url) app.jobs.add(`archive:entry:${id}`, hostOf(url), () => archiveEntry(app, id, "fetch").then(() => undefined), -2);
      }
    }
    if (!feed.hasIcon) {
      const site = res.siteUrl || (feed.kind === "rsshub" ? null : feed.url);
      // A channel that links back to the feed itself is a bridge (we-mp-rss): its favicon is the same for every
      // feed, so the channel image (the account avatar) makes the better icon.
      const preferred = res.image && site && samePath(site, res.resolvedUrl) ? res.image : null;
      if (site) app.jobs.add(`icon:${feed.id}`, "", () => fetchIcon(app, feed.id, site, res.items.find((i) => i.url)?.url || null, preferred), -3);
    }
    app.events.emit({ type: "feed", feedId: feed.id, ok: true });
    return { added: added.length };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`refresh failed for #${feed.id} ${feed.title}`, msg);
    app.feeds.recordError(feed.id, Date.now(), nextFetchAt(app, feed, true), msg);
    app.feeds.log(feed.id, { at: started, status: "error", added: 0, ms: Date.now() - started, error: msg.slice(0, 500) });
    app.events.emit({ type: "feed", feedId: feed.id, ok: false, error: msg });
    return { added: 0, error: msg };
  }
}

export function queueRefresh(app: App, feedId: number, priority = 0): boolean {
  const feed = app.feeds.get(feedId);
  if (!feed) return false;
  const host = feed.kind === "rsshub" ? "rsshub" : feed.kind === "plugin" ? `plugin:${feed.url}` : hostOf(feed.url);
  return app.jobs.add(`refresh:${feedId}`, host, () => refreshFeed(app, feedId).then(() => undefined), priority);
}
