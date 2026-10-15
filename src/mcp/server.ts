/**
 * Acorn MCP server (stdio). Lets agents such as Claude Code or Hermes read, search, subscribe, archive and annotate.
 *
 *   claude mcp add acorn -- node --disable-warning=ExperimentalWarning /path/to/acorn/src/mcp/server.ts
 *
 * It talks to the running Acorn server over HTTP (ACORN_URL, default http://127.0.0.1:7700) using data/.cli-token.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, unproxify } from "../client/client.ts";
import { toMarkdown } from "../server/content/markdown.ts";
import { VERSION } from "../server/config.ts";
import type { EntrySummary, Feed } from "../shared/types.ts";

const api = createClient();
const server = new McpServer({ name: "acorn", version: VERSION });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const asJson = (v: unknown) => text(JSON.stringify(v, null, 2));
const when = (t: number | null | undefined) => {
  if (!t) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function entryLine(e: EntrySummary, feeds: Map<number, Feed>): string {
  const flags = [e.readAt ? "" : "未读", e.starredAt ? "稍后读" : "", e.archiveId ? `已藏#${e.archiveId}` : "", e.highlightCount ? `${e.highlightCount}条批注` : ""].filter(Boolean).join(",");
  return `- [${e.id}] ${e.title} — ${feeds.get(e.feedId)?.title || ""} · ${when(e.publishedAt || e.createdAt)}${flags ? ` (${flags})` : ""}${e.summary ? `\n  ${e.summary.slice(0, 160)}` : ""}`;
}

async function feedMap() {
  return new Map((await api.feeds()).map((f) => [f.id, f]));
}

server.registerTool(
  "acorn_overview",
  {
    title: "松果概览",
    description: "Counts (unread/today/starred/archived/gone/highlights), failing feeds and the newest unread items. Call this first to orient yourself.",
    inputSchema: {},
  },
  async () => {
    const [counts, feeds, unread] = await Promise.all([api.counts(), api.feeds(), api.entries({ view: "unread", limit: 15 })]);
    const map = new Map(feeds.map((f) => [f.id, f]));
    const failing = feeds.filter((f) => f.errorCount > 0);
    return text(
      [
        `未读 ${counts.unread} · 24小时内未读 ${counts.today} · 稍后读 ${counts.starred} · 在读 ${counts.inProgress}`,
        `已藏 ${counts.archived}（原文已消失 ${counts.gone}）· 批注 ${counts.highlights} · 订阅源 ${counts.feeds}`,
        failing.length ? `\n抓取失败的订阅源:\n${failing.map((f) => `- [feed ${f.id}] ${f.title}: ${f.lastError}`).join("\n")}` : "",
        `\n最新未读:\n${unread.items.map((e) => entryLine(e, map)).join("\n")}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "list_entries",
  {
    title: "列出文章",
    description: "List entries. view: today (last 24h), unread, starred (read-later), progress (half-read), archived, all. Filter by feed_id or folder_id. Returns ids for read_entry.",
    inputSchema: {
      view: z.enum(["today", "unread", "starred", "progress", "archived", "all"]).optional(),
      feed_id: z.number().int().optional(),
      folder_id: z.number().int().optional(),
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    },
  },
  async (a) => {
    const page = await api.entries({ view: a.view, feed: a.feed_id, folder: a.folder_id, unread: a.unread_only, limit: a.limit || 30, cursor: a.cursor });
    const map = await feedMap();
    return text(`${page.items.map((e) => entryLine(e, map)).join("\n") || "（没有文章）"}${page.nextCursor ? `\n\nnext cursor: ${page.nextCursor}` : ""}`);
  },
);

server.registerTool(
  "read_entry",
  {
    title: "读文章",
    description: "Read one entry as Markdown (full text when available) with its highlights. Marks it read unless mark_read=false. Set fetch_full=true to fetch the original page first.",
    inputSchema: { id: z.number().int(), mark_read: z.boolean().optional(), fetch_full: z.boolean().optional() },
  },
  async (a) => {
    let e = await api.entry(a.id);
    if (a.fetch_full && !e.hasFullContent && e.url) e = (await api.fulltext(a.id)).entry;
    if (a.mark_read !== false && !e.readAt) await api.patchEntry(a.id, { read: true });
    const hl = e.highlights.map((h) => `> ${h.quote}${h.note ? `\n\n批注：${h.note}` : ""}`).join("\n\n");
    return text(
      `# ${e.title}\n\n来源: ${e.url || "（无链接）"}\n作者: ${e.author || "未知"} · 发布: ${when(e.publishedAt)} · ${e.wordCount} 字${e.archive ? ` · 已藏 #${e.archive.id}（原文状态 ${e.archive.sourceStatus}）` : ""}\n\n${toMarkdown(unproxify(e.content))}${hl ? `\n\n## 批注\n\n${hl}` : ""}`,
    );
  },
);

server.registerTool(
  "search",
  {
    title: "搜索",
    description: "Full-text search across entries, archives and highlights (Chinese substring search works for 3+ characters).",
    inputSchema: { query: z.string().min(1) },
  },
  async (a) => {
    const r = await api.search(a.query);
    const map = await feedMap();
    return text(
      [
        r.entries.length ? `## 文章\n${r.entries.map((e) => entryLine(e, map)).join("\n")}` : "",
        r.archives.length ? `## 存档\n${r.archives.map((x) => `- [archive ${x.id}] ${x.title} — ${x.site || ""} · ${x.sourceStatus}`).join("\n")}` : "",
        r.highlights.length ? `## 批注\n${r.highlights.map((h) => `- 「${h.quote.slice(0, 120)}」${h.note ? ` 批注：${h.note}` : ""} — ${h.title || ""}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n") || "没有结果",
    );
  },
);

server.registerTool(
  "set_entry_state",
  {
    title: "标记文章",
    description: "Mark entries read/unread and/or add/remove from read-later (starred). Starring archives the article locally by default.",
    inputSchema: { ids: z.array(z.number().int()).min(1), read: z.boolean().optional(), starred: z.boolean().optional() },
  },
  async (a) => {
    if (a.read !== undefined) await api.mark({ ids: a.ids, read: a.read });
    if (a.starred !== undefined) for (const id of a.ids) await api.patchEntry(id, { starred: a.starred });
    return text("OK");
  },
);

server.registerTool(
  "list_feeds",
  { title: "订阅源", description: "All subscriptions with kind, url, unread/total and last error.", inputSchema: {} },
  async () => {
    const feeds = await api.feeds();
    return text(feeds.map((f) => `- [feed ${f.id}] ${f.title} (${f.kind}) ${f.url} · 未读 ${f.unread}/${f.total}${f.paused ? " · 暂停" : ""}${f.lastError ? ` · 错误: ${f.lastError}` : ""}`).join("\n") || "（还没有订阅）");
  },
);

const HTML_RULE = z
  .object({ item: z.string(), title: z.string().optional(), link: z.string().optional(), date: z.string().optional(), summary: z.string().optional() })
  .describe("CSS selectors for an HTML list page. item matches each row; append @attr to read an attribute, e.g. a@href.");

server.registerTool(
  "preview_source",
  {
    title: "预览订阅源",
    description:
      "Fetch a source without subscribing. Works for RSS/Atom/JSON feeds, rsshub:// routes, web pages (returns discovered feeds or an auto-detected HTML list rule), and plugins (input = plugin id, kind = plugin).",
    inputSchema: {
      input: z.string(),
      kind: z.enum(["feed", "rsshub", "html", "plugin"]).optional(),
      html_rule: HTML_RULE.optional(),
      plugin_params: z.record(z.string(), z.string()).optional(),
    },
  },
  async (a) => {
    const config = a.html_rule ? { html: a.html_rule } : a.kind === "plugin" ? { plugin: { id: a.input, params: a.plugin_params || {} } } : undefined;
    return asJson(await api.preview(a.input, a.kind, config));
  },
);

server.registerTool(
  "add_feed",
  {
    title: "添加订阅",
    description:
      "Subscribe. input: URL of a feed or website, rsshub://route, school/department notice page (kind=html, optionally with html_rule), or plugin id (kind=plugin). auto_archive stores every new item locally.",
    inputSchema: {
      input: z.string(),
      kind: z.enum(["feed", "rsshub", "html", "plugin"]).optional(),
      title: z.string().optional(),
      folder: z.string().optional(),
      html_rule: HTML_RULE.optional(),
      plugin_params: z.record(z.string(), z.string()).optional(),
      full_text: z.enum(["never", "auto", "always"]).optional(),
      auto_archive: z.boolean().optional(),
    },
  },
  async (a) => {
    const config = a.html_rule ? { html: a.html_rule } : a.kind === "plugin" ? { plugin: { id: a.input, params: a.plugin_params || {} } } : undefined;
    try {
      const r = await api.addFeed({ input: a.input, kind: a.kind, title: a.title, folderName: a.folder, config, fullText: a.full_text, autoArchive: a.auto_archive });
      return text(`${r.existed ? "已经订阅过" : "已订阅"} [feed ${r.feed.id}] ${r.feed.title}，收到 ${r.added} 篇${r.error ? `；抓取出错：${r.error}` : ""}`);
    } catch (err) {
      const e = err as Error & { data?: Record<string, unknown> };
      return asJson({ error: e.message, preview: e.data?.preview });
    }
  },
);

server.registerTool(
  "update_feed",
  {
    title: "修改订阅源",
    description: "Change a feed: custom title, html_rule (for kind=html), full_text mode, auto_archive, fetch interval minutes, paused, url.",
    inputSchema: {
      id: z.number().int(),
      title: z.string().optional(),
      html_rule: HTML_RULE.optional(),
      full_text: z.enum(["never", "auto", "always"]).optional(),
      auto_archive: z.boolean().optional(),
      interval_minutes: z.number().int().min(5).optional(),
      paused: z.boolean().optional(),
      url: z.string().optional(),
      content_selector: z.string().optional().describe("CSS selector of the article body, when automatic extraction picks the wrong part of the page"),
    },
  },
  async (a) => {
    const feed = (await api.feeds()).find((f) => f.id === a.id);
    if (!feed) return text("没有这个订阅源");
    const config = { ...feed.config, ...(a.html_rule ? { html: a.html_rule } : {}), ...(a.content_selector !== undefined ? { contentSelector: a.content_selector } : {}) };
    const r = await api.updateFeed(a.id, {
      customTitle: a.title,
      config,
      fullText: a.full_text,
      autoArchive: a.auto_archive,
      fetchInterval: a.interval_minutes,
      paused: a.paused,
      url: a.url,
    });
    return text(`已更新 [feed ${r.id}] ${r.title}`);
  },
);

server.registerTool(
  "refresh_feed",
  { title: "刷新", description: "Refresh one feed now (waits for the result), or all feeds when id is omitted (queued).", inputSchema: { id: z.number().int().optional() } },
  async (a) => (a.id ? asJson(await api.refreshFeed(a.id)) : asJson(await api.refreshAll())),
);

server.registerTool(
  "wechat_accounts",
  {
    title: "微信公众号",
    description:
      "WeChat Official Accounts come from the user's we-mp-rss instance (subscribe there by account name; it needs a WeChat QR login). Lists its accounts and whether each is a feed here; sync=true subscribes to the missing ones now (otherwise this happens every 10 minutes).",
    inputSchema: { sync: z.boolean().optional() },
  },
  async (a) => (a.sync ? asJson(await api.wechatSync()) : asJson(await api.wechatBridge())),
);

server.registerTool(
  "archive",
  {
    title: "入藏",
    description:
      "Save a web page (url) or entry (entry_id) to the local archive: article text, images, attachments and the raw page. method=browser renders it in the user's own logged-in browser (ego-browser) and also stores MHTML + screenshot; use it for WeChat, Xiaohongshu, Zhihu or pages behind a login.",
    inputSchema: {
      url: z.string().optional(),
      entry_id: z.number().int().optional(),
      method: z.enum(["fetch", "browser"]).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (a) => {
    try {
      return asJson(await api.capture({ url: a.url, entryId: a.entry_id, method: a.method, tags: a.tags }));
    } catch (err) {
      const e = err as Error & { status?: number; data?: Record<string, unknown> };
      if (e.status === 423 && e.data?.spaceId) {
        return text(
          `需要用户验证：${e.message}\n页面已在用户的 ego 浏览器（空间 ${e.data.spaceId}）中打开。请让用户完成验证并看到正文，然后调用 resume_browser_capture，space_id=${e.data.spaceId}。不要尝试自己完成验证。`,
        );
      }
      throw err;
    }
  },
);

server.registerTool(
  "resume_browser_capture",
  {
    title: "验证后继续入藏",
    description: "After the user passed a captcha / login in the ego-browser page Acorn handed them, archive that page. Use the space_id returned by archive.",
    inputSchema: { space_id: z.number().int() },
  },
  async (a) => asJson(await api.resumeCapture(a.space_id)),
);

server.registerTool(
  "archive_open_tab",
  {
    title: "入藏浏览器里已打开的页面",
    description: "Archive the page already open in an ego-browser space (e.g. an article the user opened and verified themselves). The user's own tabs are returned to them untouched.",
    inputSchema: { space_id: z.number().int(), url: z.string().optional().describe("Original article URL, if known") },
  },
  async (a) => asJson(await api.captureOpenTab(a.space_id, a.url)),
);

server.registerTool(
  "list_archives",
  {
    title: "存档列表",
    description: "List archived pages. status=gone lists articles whose original has disappeared; changed lists edited ones.",
    inputSchema: { query: z.string().optional(), status: z.enum(["alive", "changed", "gone", "unknown"]).optional(), tag: z.string().optional(), limit: z.number().int().optional() },
  },
  async (a) => {
    const page = await api.archives({ q: a.query, status: a.status, tag: a.tag, limit: a.limit || 30 });
    return text(page.items.map((x) => `- [archive ${x.id}] ${x.title} — ${x.site || ""} · 藏于 ${when(x.createdAt)} · ${x.sourceStatus} · ${x.snapshotCount} 个版本${x.tags.length ? ` · #${x.tags.join(" #")}` : ""}`).join("\n") || "（没有存档）");
  },
);

server.registerTool(
  "read_archive",
  {
    title: "读存档",
    description: "Read an archived page as Markdown, with its snapshots and the folder path on disk.",
    inputSchema: { id: z.number().int() },
  },
  async (a) => {
    const x = await api.archive(a.id);
    return text(
      `# ${x.title}\n\n原文: ${x.url}（${x.sourceStatus}）\n本地文件夹: ${x.absolutePath}\n版本: ${x.snapshots.map((s) => `${when(s.capturedAt)} ${s.method}`).join("; ")}\n标签: ${x.tags.join(", ") || "无"}${x.note ? `\n备注: ${x.note}` : ""}\n\n${toMarkdown(unproxify(x.content))}`,
    );
  },
);

server.registerTool(
  "tag_archive",
  { title: "存档标签与备注", description: "Set tags and/or a note on an archive.", inputSchema: { id: z.number().int(), tags: z.array(z.string()).optional(), note: z.string().optional() } },
  async (a) => {
    const r = await api.patchArchive(a.id, { tags: a.tags, note: a.note });
    return text(`已更新 [archive ${r.id}] 标签: ${r.tags.join(", ")}`);
  },
);

server.registerTool(
  "list_highlights",
  { title: "批注", description: "Recent highlights and notes, optionally filtered by a search query.", inputSchema: { query: z.string().optional(), limit: z.number().int().optional() } },
  async (a) => {
    const page = await api.highlights(a.query, a.limit || 40);
    return text(page.items.map((h) => `- 「${h.quote}」${h.note ? `\n  批注：${h.note}` : ""}\n  —— ${h.title || ""} (${h.entryId ? `entry ${h.entryId}` : `archive ${h.archiveId}`})`).join("\n") || "（还没有批注）");
  },
);

server.registerTool(
  "add_highlight",
  {
    title: "添加批注",
    description: "Highlight an exact quote from an entry or archive, optionally with a note. The quote must appear verbatim in the article text.",
    inputSchema: { entry_id: z.number().int().optional(), archive_id: z.number().int().optional(), quote: z.string().min(1), note: z.string().optional(), color: z.enum(["amber", "green", "blue", "rose", "violet"]).optional() },
  },
  async (a) => asJson(await api.addHighlight({ entryId: a.entry_id, archiveId: a.archive_id, quote: a.quote, note: a.note, color: a.color })),
);

server.registerTool(
  "digest",
  { title: "摘要", description: "Preview the daily digest text, or send it to Telegram when send=true.", inputSchema: { send: z.boolean().optional() } },
  async (a) => {
    if (a.send) {
      await api.digestSend();
      return text("已发送到 Telegram");
    }
    return text((await api.digestPreview()).html.replace(/<[^>]+>/g, ""));
  },
);

await server.connect(new StdioServerTransport());
