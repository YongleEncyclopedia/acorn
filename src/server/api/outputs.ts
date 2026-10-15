/**
 * Re-publish Acorn data as standard RSS so other tools (TrendRadar, another reader, a script) can consume it:
 *   /out/feed/<feedId>.xml?key=<token>   any subscription, including scraped web pages and plugins, with full text
 *   /out/folder/<folderId>.xml?key=…      a whole folder
 *   /out/archive.xml?key=…                everything you archived
 *   /out/starred.xml?key=…                read-later
 * The key is an API token (Settings → Agent 与 API 令牌).
 */
import type { Hono, Context } from "hono";
import type { App } from "../app.ts";
import type { Param } from "../db/index.ts";
import { bearer } from "./auth.ts";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

interface Item {
  title: string;
  link: string | null;
  guid: string;
  date: number;
  author: string | null;
  html: string;
}

function rss(title: string, link: string, items: Item[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${esc(title)}</title>
<link>${esc(link)}</link>
<description>${esc(`${title} · 由松果 Acorn 输出`)}</description>
<generator>Acorn</generator>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items
  .map(
    (i) => `<item>
<title>${esc(i.title)}</title>
${i.link ? `<link>${esc(i.link)}</link>` : ""}
<guid isPermaLink="false">${esc(i.guid)}</guid>
<pubDate>${new Date(i.date).toUTCString()}</pubDate>
${i.author ? `<dc:creator>${esc(i.author)}</dc:creator>` : ""}
<description>${cdata(i.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400))}</description>
<content:encoded>${cdata(i.html)}</content:encoded>
</item>`,
  )
  .join("\n")}
</channel>
</rss>
`;
}

function authorized(app: App, c: Context): boolean {
  const key = c.req.query("key") || bearer(c) || "";
  return !!(key && app.tokens.verify(key));
}

interface Row {
  id: number;
  title: string;
  url: string | null;
  guid: string;
  sort_at: number;
  author: string | null;
  content: string | null;
  full_content: string | null;
}

export function registerOutputs(r: Hono, app: App): void {
  const entries = (where: string, params: Param[], limit = 50): Item[] =>
    app.db
      .all<Row>(`select id, title, url, guid, sort_at, author, content, full_content from entries e where ${where} order by sort_at desc limit ?`, ...params, limit)
      .map((e) => ({ title: e.title, link: e.url, guid: `acorn-entry-${e.id}-${e.guid}`, date: e.sort_at, author: e.author, html: e.full_content || e.content || "" }));
  const send = (c: Context, xml: string) => c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "no-cache" });

  r.get("/out/feed/:file", (c) => {
    if (!authorized(app, c)) return c.text("需要 key（API 令牌）", 401);
    const id = Number(c.req.param("file").replace(/\.xml$/, ""));
    const feed = app.feeds.get(id);
    if (!feed) return c.text("not found", 404);
    return send(c, rss(feed.title, feed.siteUrl || feed.url, entries("e.feed_id = ?", [id])));
  });
  r.get("/out/folder/:file", (c) => {
    if (!authorized(app, c)) return c.text("需要 key（API 令牌）", 401);
    const id = Number(c.req.param("file").replace(/\.xml$/, ""));
    const folder = app.feeds.folders().find((f) => f.id === id);
    if (!folder) return c.text("not found", 404);
    return send(c, rss(folder.name, app.cfg.publicUrl, entries("e.feed_id in (select id from feeds where folder_id = ?)", [id], 100)));
  });
  r.get("/out/starred.xml", (c) => {
    if (!authorized(app, c)) return c.text("需要 key（API 令牌）", 401);
    return send(c, rss("松果 · 稍后读", app.cfg.publicUrl, entries("e.starred_at is not null", [], 100)));
  });
  r.get("/out/archive.xml", (c) => {
    if (!authorized(app, c)) return c.text("需要 key（API 令牌）", 401);
    const rows = app.db.all<{ id: number; title: string; url: string; created_at: number; author: string | null; excerpt: string | null }>(
      "select id, title, url, created_at, author, excerpt from archives order by created_at desc limit 100",
    );
    return send(
      c,
      rss(
        "松果 · 藏",
        `${app.cfg.publicUrl}/archive`,
        rows.map((a) => ({ title: a.title, link: a.url, guid: `acorn-archive-${a.id}`, date: a.created_at, author: a.author, html: `<p>${esc(a.excerpt || "")}</p><p><a href="${app.cfg.publicUrl}/archive/${a.id}">在松果中查看存档</a></p>` })),
      ),
    );
  });
}
