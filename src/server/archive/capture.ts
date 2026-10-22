import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { canonicalUrl, hostOf } from "../util/url.ts";
import { countWords, excerpt, htmlToText, sha1, sha256, similarity, slugify } from "../util/text.ts";
import { extractArticle, pageMetadata, type Extracted } from "../content/extract.ts";
import { sanitize } from "../content/sanitize.ts";
import { detectBlocked, detectGone, ruleFor } from "../content/rules/index.ts";
import { toMarkdown } from "../content/markdown.ts";
import { parseMhtml, type Mhtml } from "./mhtml.ts";
import { localizeAssets } from "./assets.ts";
import { renderArchivePage } from "./template.ts";
import { logger } from "../util/log.ts";

const log = logger("archive");

export class BlockedError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

export interface CaptureInput {
  url: string;
  entryId?: number | null;
  method: "fetch" | "browser" | "feed" | "import";
  /** Pre-fetched page HTML (browser capture, imports, rechecks). */
  html?: string | null;
  finalUrl?: string;
  status?: number;
  mhtml?: Buffer | null;
  screenshot?: Buffer | null;
  /** Store a new snapshot even if the text did not change. */
  force?: boolean;
  tags?: string[];
  title?: string;
}

export interface CaptureResult {
  archiveId: number;
  snapshotId: number | null;
  created: boolean;
  unchanged: boolean;
  gone: string | null;
  warnings: string[];
  title: string;
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function snapshotText(app: App, dir: string): string {
  const file = path.join(app.cfg.archiveDir, dir, "content.html");
  return existsSync(file) ? htmlToText(readFileSync(file, "utf8")) : "";
}

function dirSize(dir: string, files: string[]): number {
  let n = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    if (existsSync(p)) n += statSync(p).size;
  }
  return n;
}

/**
 * Capture a URL into the local archive: fetch (or use provided HTML/MHTML), extract the article,
 * download images, and write a self-contained snapshot folder. Re-capturing an unchanged page is a no-op.
 */
export async function capture(app: App, input: CaptureInput): Promise<CaptureResult> {
  const url = canonicalUrl(input.url);
  const existing = app.archives.byUrl(url);
  const entry = input.entryId ? app.entries.row(input.entryId) : app.entries.byUrl(input.url) || app.entries.byUrl(url);
  const feed = entry ? app.feeds.get(entry.feed_id) : undefined;
  const warnings: string[] = [];
  const now = Date.now();

  let mhtml: Mhtml | null = null;
  if (input.mhtml?.length) {
    try {
      mhtml = parseMhtml(input.mhtml);
    } catch (err) {
      warnings.push(`MHTML 解析失败：${(err as Error).message}`);
    }
  }
  let html = input.html ?? mhtml?.html ?? null;
  let finalUrl = input.finalUrl || mhtml?.url || input.url;
  let status = input.status ?? (html ? 200 : 0);
  const entryHtml = entry ? entry.full_content || entry.content : null;
  const entryText = htmlToText(entryHtml);
  // Sites like WeChat answer every server fetch with a captcha; when the feed already has the article, keep that.
  const feedCopyOnly = !html && input.method === "fetch" && entryText.length > 200 && !!ruleFor(input.url)?.preferFeedCopy;
  if (!html && input.method !== "feed" && !feedCopyOnly) {
    try {
      const res = await httpGet(input.url, {
        userAgent: feed?.config.userAgent || app.cfg.pageUserAgent,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        cookie: feed?.config.cookie,
        timeoutMs: 40_000,
        maxBytes: 25 * 1024 * 1024,
      });
      status = res.status;
      finalUrl = res.url;
      const body = decodeBody(res.body, res.contentType);
      if (res.ok && /html|xml|text\/plain/i.test(res.contentType || "text/html")) html = body;
      else if (!res.ok) {
        warnings.push(`原网页返回 HTTP ${res.status}`);
        if (detectGone(finalUrl, body, res.status)) html = body;
      } else warnings.push(`原网页不是 HTML（${res.contentType}）`);
    } catch (err) {
      warnings.push(`原网页无法访问：${(err as Error).message}`);
    }
  }
  const blocked = html ? detectBlocked(finalUrl, html) : null;
  if (blocked) {
    warnings.push(`${blocked}：服务器抓到的是验证页，不是正文。可以在浏览器里完成验证后，用「浏览器入藏」重新保存`);
    html = null;
  }
  const gone = !blocked && (html !== null || status) ? detectGone(finalUrl, html || "", status) : null;

  let article: Extracted | null = html && !gone ? extractArticle(html, finalUrl, { contentSelector: feed?.config.contentSelector }) : null;
  const fromEntry = (): Extracted => ({
    title: entry!.title,
    byline: entry!.author,
    siteName: feed?.title || hostOf(entry!.url),
    publishedAt: entry!.published_at,
    lang: null,
    contentHtml: entryHtml || "",
    text: entryText,
    excerpt: excerpt(entryText, 200),
    leadImage: entry!.image,
    wordCount: countWords(entryText),
    rule: null,
  });
  if (article && entry && entryText.length > article.text.length * 1.4 && entryText.length > 200) {
    article = { ...article, contentHtml: entryHtml || article.contentHtml, text: entryText, wordCount: countWords(entryText) };
  }
  let method = input.method;
  const onlyTitle = !!entry && entryText.replace(/\s+/g, "") === (entry.title || "").replace(/\s+/g, "");
  if (!article && entry && entryText.length > 20 && !onlyTitle) {
    article = fromEntry();
    if (method === "fetch") method = "feed";
    if (!gone && !blocked && !feedCopyOnly) warnings.push("网页正文提取失败，使用订阅源中的内容");
    if (blocked) warnings.push("已先用订阅源中的全文存档");
  }
  if (!article && html && !gone) {
    const meta = pageMetadata(html, finalUrl);
    const body = sanitize(`${meta.description ? `<p>${meta.description}</p>` : ""}${meta.image ? `<img src="${meta.image}">` : ""}`, finalUrl);
    const text = htmlToText(body);
    article = { title: meta.title, byline: null, siteName: meta.siteName, publishedAt: null, lang: null, contentHtml: body, text, excerpt: excerpt(text), leadImage: meta.image, wordCount: countWords(text), rule: null };
    warnings.push("没有识别出正文，只保存了页面摘要与原始网页");
  }

  if (!article) {
    if (existing) {
      app.archives.setSourceStatus(existing.id, gone ? "gone" : "unknown", now);
      if (entry) app.archives.linkEntry(existing.id, entry.id);
      return { archiveId: existing.id, snapshotId: null, created: false, unchanged: true, gone, warnings, title: existing.title };
    }
    if (blocked) throw new BlockedError(`${blocked}。请在浏览器里打开原文完成验证，再用「浏览器入藏」保存`, blocked);
    throw new Error(gone ? `原文已失效（${gone}），且没有可用的副本` : warnings[warnings.length - 1] || "没有可存档的内容");
  }

  const title = (input.title || entry?.title || article.title || finalUrl).trim();
  const site = article.siteName || feed?.title || hostOf(finalUrl) || null;
  const author = entry?.author || article.byline || null;
  const publishedAt = entry?.published_at ?? article.publishedAt ?? null;
  const text = article.text;
  const hash = sha256(text.replace(/\s+/g, ""));

  let changed = false;
  if (existing) {
    const latest = app.archives.latestSnapshot(existing.id);
    if (latest && !input.force) {
      const same = latest.content_hash === hash || similarity(snapshotText(app, latest.dir), text) >= 0.97;
      if (same) {
        app.archives.setSourceStatus(existing.id, gone ? "gone" : "alive", now);
        if (entry) app.archives.linkEntry(existing.id, entry.id);
        return { archiveId: existing.id, snapshotId: null, created: false, unchanged: true, gone, warnings, title: existing.title };
      }
    }
    if (latest) changed = similarity(snapshotText(app, latest.dir), text) < 0.9;
  }

  const d = new Date(now);
  const archiveDir = existing?.dir || `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${slugify(title)}-${sha1(url).slice(0, 6)}`;
  const snapDir = `${archiveDir}/${stamp(now)}`;
  const abs = path.join(app.cfg.archiveDir, snapDir);
  mkdirSync(abs, { recursive: true });

  const assets = await localizeAssets(article.contentHtml, { pageUrl: finalUrl, dir: abs, mhtml, leadImage: article.leadImage || entry?.image || null, userAgent: app.cfg.pageUserAgent });
  if (assets.failed.length) warnings.push(`${assets.failed.length} 张图片未能保存，保留了远程地址`);

  const words = countWords(text);
  writeFileSync(path.join(abs, "content.html"), assets.html);
  writeFileSync(path.join(abs, "article.html"), renderArchivePage({ title, url: input.url, site, author, publishedAt, capturedAt: now, method, contentHtml: assets.html, words }));
  const header = [`# ${title}`, "", `> 原文：<${input.url}>`, `> 存档：${new Date(now).toLocaleString("zh-CN", { hour12: false })}${site ? ` · ${site}` : ""}${author ? ` · ${author}` : ""}`, "", ""].join("\n");
  writeFileSync(path.join(abs, "article.md"), header + toMarkdown(assets.html));
  if (html) writeFileSync(path.join(abs, "source.html"), html);
  if (input.mhtml?.length) writeFileSync(path.join(abs, "page.mhtml"), input.mhtml);
  if (input.screenshot?.length) writeFileSync(path.join(abs, "screenshot.png"), input.screenshot);
  const meta = {
    url: input.url,
    canonicalUrl: url,
    finalUrl,
    title,
    site,
    author,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    capturedAt: new Date(now).toISOString(),
    method,
    contentHash: hash,
    words,
    status: gone ? "gone" : "ok",
    warnings,
    assets: assets.files,
    attachments: assets.attachments,
    failedAssets: assets.failed,
    generator: "Acorn 松果",
  };
  writeFileSync(path.join(abs, "meta.json"), JSON.stringify(meta, null, 2));
  const bytes = assets.bytes + dirSize(abs, ["content.html", "article.html", "article.md", "source.html", "page.mhtml", "screenshot.png", "meta.json"]);

  const archiveId =
    existing?.id ??
    app.archives.create({ url, entryId: entry?.id ?? null, title, site, author, publishedAt, excerpt: article.excerpt || null, dir: archiveDir, tags: input.tags });
  const snapshotId = app.archives.addSnapshot(
    archiveId,
    {
      capturedAt: now,
      method,
      dir: snapDir,
      contentHash: hash,
      textLength: text.length,
      bytes,
      assets: assets.files.length,
      hasMhtml: !!input.mhtml?.length,
      hasScreenshot: !!input.screenshot?.length,
      status: assets.failed.length ? "partial" : "ok",
      warnings,
      leadImage: assets.leadFile ? `${snapDir}/${assets.leadFile}` : null,
    },
    { title, site, author, publishedAt, excerpt: article.excerpt || null },
  );
  if (input.tags?.length && existing) {
    const cur = JSON.parse(existing.tags || "[]") as string[];
    app.archives.update(archiveId, { tags: [...cur, ...input.tags] });
  }
  if (entry) {
    app.archives.linkEntry(archiveId, entry.id);
    if (!entry.full_content && method !== "feed" && html) app.entries.setFullContent(entry.id, article.contentHtml, null, entry.title, words);
  }
  app.archives.setSourceStatus(archiveId, gone ? "gone" : changed ? "changed" : "alive", now);
  app.archives.index(archiveId, title, `${site || ""}\n${author || ""}\n${text}`);
  log.info(`archived #${archiveId} ${title} (${assets.files.length} images, ${assets.attachments.length} attachments, ${Math.round(bytes / 1024)} KB)`);
  app.events.emit({ type: "archive", archiveId, url: input.url, status: "done", title });
  app.events.emit({ type: "counts" });
  return { archiveId, snapshotId, created: !existing, unchanged: false, gone, warnings, title };
}

/** Archive a feed entry (used by star / highlight / auto-archive). */
export async function archiveEntry(app: App, entryId: number, method: "fetch" | "browser" = "fetch"): Promise<CaptureResult | null> {
  const row = app.entries.row(entryId);
  if (!row) return null;
  if (!row.url) return capture(app, { url: `acorn:entry/${entryId}`, entryId, method: "feed" });
  if (method === "browser") {
    const { browserCapture } = await import("./browser.ts");
    const shot = await browserCapture(app, row.url, { entryId });
    return capture(app, { url: row.url, entryId, method: "browser", html: shot.html, finalUrl: shot.finalUrl, mhtml: shot.mhtml, screenshot: shot.screenshot, force: true });
  }
  return capture(app, { url: row.url, entryId, method: "fetch" });
}

/** Queue a capture as background work and report progress over the event stream. */
export function queueCapture(app: App, input: Omit<CaptureInput, "method"> & { method: "fetch" | "browser" }): boolean {
  const key = `archive:${canonicalUrl(input.url)}:${input.method}`;
  const host = input.method === "browser" ? "ego-browser" : hostOf(input.url);
  const ok = app.jobs.add(
    key,
    host,
    async () => {
      try {
        if (input.method === "browser") {
          const { browserCapture } = await import("./browser.ts");
          const shot = await browserCapture(app, input.url, { entryId: input.entryId, tags: input.tags, title: input.title });
          await capture(app, { ...input, method: "browser", html: shot.html, finalUrl: shot.finalUrl, mhtml: shot.mhtml, screenshot: shot.screenshot, force: true });
        } else {
          await capture(app, { ...input, method: "fetch" });
        }
      } catch (err) {
        const e = err as Error & { spaceId?: number | null };
        if (e.name === "BrowserBlockedError" || e.constructor?.name === "BrowserBlockedError") {
          app.events.emit({ type: "archive", archiveId: null, url: input.url, status: "verify", error: e.message, spaceId: e.spaceId ?? null, title: input.title });
          return;
        }
        log.warn(`capture failed ${input.url}`, err);
        app.events.emit({ type: "archive", archiveId: null, url: input.url, status: "error", error: e.message });
      }
    },
    5,
  );
  if (ok) app.events.emit({ type: "archive", archiveId: null, url: input.url, status: "queued" });
  return ok;
}

/** Finish a browser capture the user unblocked by passing a verification in the handed-off page. */
export async function resumeCapture(app: App, spaceId: number): Promise<CaptureResult> {
  const { resumeBrowserCapture } = await import("./browser.ts");
  const { shot, pending } = await resumeBrowserCapture(app, spaceId);
  return capture(app, {
    url: pending.url,
    entryId: pending.entryId,
    method: "browser",
    html: shot.html,
    finalUrl: shot.finalUrl,
    mhtml: shot.mhtml,
    screenshot: shot.screenshot,
    tags: pending.tags,
    title: pending.title,
    force: true,
  });
}
