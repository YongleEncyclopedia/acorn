import type { App } from "../app.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { detectBlocked, detectGone, stillShows } from "../content/rules/index.ts";
import { extractArticle } from "../content/extract.ts";
import { similarity } from "../util/text.ts";
import { capture, snapshotText } from "./capture.ts";
import { readsWithAccount } from "../accounts/use.ts";
import type { SourceStatus } from "../../shared/types.ts";
import { logger } from "../util/log.ts";

const log = logger("recheck");

/**
 * Visit an archived article's original URL. Marks it gone when deleted/censored, and stores a new snapshot
 * when the text changed noticeably (so edits are preserved as versions). A page that still shows the archived
 * text is not gone, whatever else it says (a notice may well quote 该内容已被删除); a captcha or login wall in
 * its place leaves the status unknown.
 */
export async function recheckArchive(app: App, archiveId: number): Promise<{ status: SourceStatus; reason?: string }> {
  const a = app.archives.row(archiveId);
  if (!a) throw new Error("存档不存在");
  if (!/^https?:/i.test(a.url)) return { status: a.source_status };
  const now = Date.now();
  // A post from a platform read with the user's sign-in (知识星球, Canvas): the server would see a login page or an
  // empty app shell there, and take it for a change. Nothing can be learned by visiting; it is left alone.
  const entry = a.entry_id ? app.entries.row(a.entry_id) : undefined;
  if (entry && (await readsWithAccount(app, app.feeds.get(entry.feed_id)))) {
    app.archives.setSourceStatus(archiveId, a.source_status === "gone" ? "gone" : "unknown", now);
    return { status: a.source_status === "gone" ? "gone" : "unknown", reason: "原文要登录后才能看，松果不去回访" };
  }
  let res;
  try {
    res = await httpGet(a.url, { userAgent: app.cfg.pageUserAgent, accept: "text/html,*/*;q=0.8", timeoutMs: 30_000 });
  } catch (err) {
    app.archives.setSourceStatus(archiveId, "unknown", now);
    return { status: "unknown", reason: (err as Error).message };
  }
  const html = decodeBody(res.body, res.contentType);
  const latest = app.archives.latestSnapshot(archiveId);
  const old = latest ? snapshotText(app, latest.dir) : "";
  const gone = detectGone(res.url, html, res.status, old);
  if (gone) {
    const was = a.source_status;
    app.archives.setSourceStatus(archiveId, "gone", now);
    if (was !== "gone") {
      log.info(`source gone: #${archiveId} ${a.title} (${gone})`);
      app.events.emit({ type: "archive", archiveId, url: a.url, status: "done", title: a.title });
      app.events.emit({ type: "counts" });
    }
    return { status: "gone", reason: gone };
  }
  if (!res.ok) {
    app.archives.setSourceStatus(archiveId, "unknown", now);
    return { status: "unknown", reason: `HTTP ${res.status}` };
  }
  // A captcha or login wall in place of the article says nothing about it: neither still there nor changed.
  const blocked = stillShows(html, old) ? null : detectBlocked(res.url, html);
  if (blocked) {
    app.archives.setSourceStatus(archiveId, "unknown", now);
    return { status: "unknown", reason: blocked };
  }
  const article = extractArticle(html, res.url);
  if (article && old && similarity(old, article.text) < 0.9) {
    const saved = await capture(app, { url: a.url, method: "fetch", html, finalUrl: res.url, status: res.status, force: true });
    if (saved.snapshotId) return { status: "changed", reason: "原文内容有变化，已保存新版本" };
    return { status: app.archives.row(archiveId)?.source_status ?? "unknown", reason: saved.warnings.at(-1) };
  }
  app.archives.setSourceStatus(archiveId, a.source_status === "changed" ? "changed" : "alive", now);
  return { status: a.source_status === "changed" ? "changed" : "alive" };
}
