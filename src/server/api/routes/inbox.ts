import type { Hono, Context } from "hono";
import type { App } from "../../app.ts";
import { pushedItems } from "../../feeds/builtin/inbox.ts";
import { toIncoming } from "../../feeds/refresh.ts";
import { archiveEntry } from "../../archive/capture.ts";
import { hostOf } from "../../util/url.ts";

const MAX = 1024 * 1024;

/** What was sent, in whichever form the sender used. */
async function bodyOf(c: Context): Promise<unknown> {
  if (c.req.method === "GET") return Object.fromEntries(new URL(c.req.url).searchParams);
  const type = c.req.header("content-type") || "";
  if (Number(c.req.header("content-length") || 0) > MAX) throw new Error("消息太大了（超过 1 MB）");
  if (/json/i.test(type)) return c.req.json();
  if (/form/i.test(type)) return c.req.parseBody();
  const text = await c.req.text();
  if (text.length > MAX) throw new Error("消息太大了（超过 1 MB）");
  // a sender that says nothing about its body but sends JSON
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* plain text after all */
    }
  }
  return text;
}

/**
 * Push addresses: POST /in/<key> with JSON ({ title, text, url… }, or a list of them), a form, or plain text;
 * GET with the same fields in the query for tools that only open addresses. Public: the key is the permission.
 */
export function registerInbox(r: Hono, app: App): void {
  r.on(["GET", "POST"], "/in/:token", async (c) => {
    const token = c.req.param("token");
    const row =
      token.length >= 16
        ? app.db.get<{ id: number }>("select id from feeds where kind = 'plugin' and json_extract(config, '$.plugin.id') = 'inbox' and json_extract(config, '$.plugin.params.token') = ?", token)
        : undefined;
    const feed = row && app.feeds.get(row.id);
    if (!feed) return c.json({ ok: false, error: "这个推送地址不存在，或者已经删除了" }, 404);
    if (feed.paused) return c.json({ ok: false, error: "这个推送订阅已暂停" }, 423);
    let body: unknown;
    try {
      body = await bodyOf(c);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    const items = pushedItems(body);
    if (!items.length) {
      if (c.req.method === "GET") return c.json({ ok: true, added: 0, help: "发 POST，内容是 JSON：{\"title\": \"标题\", \"text\": \"正文\", \"url\": \"链接\"}；或者表单、纯文本（第一行是标题）" });
      return c.json({ ok: false, error: "没有收到标题、正文或链接" }, 400);
    }
    const { added } = app.entries.upsert(feed.id, items.map((it) => toIncoming(it, it.url || `${app.cfg.publicUrl}/`)));
    if (feed.autoArchive) {
      for (const id of added) {
        const url = app.entries.row(id)?.url;
        if (url) app.jobs.add(`archive:entry:${id}`, hostOf(url), () => archiveEntry(app, id, "fetch").then(() => undefined), -2);
      }
    }
    if (added.length) {
      app.events.emit({ type: "entries", feedId: feed.id, added: added.length });
      app.events.emit({ type: "counts" });
    }
    return c.json({ ok: true, added: added.length });
  });
}
