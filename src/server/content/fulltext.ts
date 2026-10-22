import type { App } from "../app.ts";
import { fetchText } from "../util/http.ts";
import { extractArticle } from "./extract.ts";
import { ruleFor, detectBlocked } from "./rules/index.ts";
import { logger } from "../util/log.ts";

const log = logger("fulltext");

/** Fetch the entry's web page and store the extracted article as its full content. */
export async function fetchFullText(app: App, entryId: number): Promise<{ ok: boolean; error?: string }> {
  const row = app.entries.row(entryId);
  if (!row?.url) return { ok: false, error: "没有原文链接" };
  const feed = app.feeds.get(row.feed_id);
  try {
    const rule = ruleFor(row.url);
    const { text, url } = await fetchText(row.url, {
      userAgent: feed?.config.userAgent || app.cfg.pageUserAgent,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      referer: rule?.imageReferer ? undefined : null,
      cookie: feed?.config.cookie,
      timeoutMs: 30_000,
    });
    const blocked = detectBlocked(url, text);
    if (blocked) throw new Error(blocked);
    const article = extractArticle(text, url, { contentSelector: feed?.config.contentSelector });
    if (!article) throw new Error("没能从网页中提取出正文");
    app.entries.setFullContent(entryId, article.contentHtml, null, row.title || article.title, article.wordCount);
    if (!row.image && article.leadImage) app.db.run("update entries set image = ? where id = ?", article.leadImage, entryId);
    // Lists without dates: the article page usually has one, which puts the entry in its real place in time.
    if (!row.published_at && article.publishedAt) app.db.run("update entries set published_at = ? where id = ?", article.publishedAt, entryId);
    app.events.emit({ type: "fulltext", entryId, ok: true });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    log.debug(`full text failed for entry ${entryId}`, msg);
    app.entries.setFullContent(entryId, null, msg.slice(0, 300), row.title, row.word_count);
    app.events.emit({ type: "fulltext", entryId, ok: false });
    return { ok: false, error: msg };
  }
}
