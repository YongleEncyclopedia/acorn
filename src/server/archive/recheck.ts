import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { detectGone } from "../content/rules/index.ts";
import { extractArticle } from "../content/extract.ts";
import { htmlToText, similarity } from "../util/text.ts";
import { capture } from "./capture.ts";
import type { SourceStatus } from "../../shared/types.ts";
import { logger } from "../util/log.ts";

const log = logger("recheck");

/**
 * Visit an archived article's original URL. Marks it gone when deleted/censored, and stores a new snapshot
 * when the text changed noticeably (so edits are preserved as versions).
 */
export async function recheckArchive(app: App, archiveId: number): Promise<{ status: SourceStatus; reason?: string }> {
  const a = app.archives.row(archiveId);
  if (!a) throw new Error("存档不存在");
  if (!/^https?:/i.test(a.url)) return { status: a.source_status };
  const now = Date.now();
  let res;
  try {
    res = await httpGet(a.url, { userAgent: app.cfg.pageUserAgent, accept: "text/html,*/*;q=0.8", timeoutMs: 30_000 });
  } catch (err) {
    app.archives.setSourceStatus(archiveId, "unknown", now);
    return { status: "unknown", reason: (err as Error).message };
  }
  const html = decodeBody(res.body, res.contentType);
  const gone = detectGone(res.url, html, res.status);
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
  const article = extractArticle(html, res.url);
  const latest = app.archives.latestSnapshot(archiveId);
  if (article && latest) {
    const file = path.join(app.cfg.archiveDir, latest.dir, "content.html");
    const old = existsSync(file) ? htmlToText(readFileSync(file, "utf8")) : "";
    if (old && similarity(old, article.text) < 0.9) {
      await capture(app, { url: a.url, method: "fetch", html, finalUrl: res.url, status: res.status, force: true });
      return { status: "changed", reason: "原文内容有变化，已保存新版本" };
    }
  }
  app.archives.setSourceStatus(archiveId, a.source_status === "changed" ? "changed" : "alive", now);
  return { status: a.source_status === "changed" ? "changed" : "alive" };
}
