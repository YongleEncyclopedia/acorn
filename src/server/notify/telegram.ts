import type { App } from "../app.ts";
import { counts } from "../app.ts";
import { logger } from "../util/log.ts";

const log = logger("telegram");

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

export function telegramConfigured(app: App): boolean {
  return !!(app.cfg.telegramToken && app.cfg.telegramChatId);
}

export async function sendTelegram(app: App, html: string): Promise<void> {
  if (!telegramConfigured(app)) throw new Error("没有配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  const chunks: string[] = [];
  let cur = "";
  for (const line of html.split("\n")) {
    if ((cur + line).length > 3800) {
      chunks.push(cur);
      cur = "";
    }
    cur += `${line}\n`;
  }
  if (cur.trim()) chunks.push(cur);
  for (const text of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${app.cfg.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: app.cfg.telegramChatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    });
    if (!res.ok) throw new Error(`Telegram 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Build the daily digest: newest unread from chosen folders, reading in progress, and sources that vanished. */
export function buildDigest(app: App): string {
  const s = app.settings.all();
  const base = app.cfg.publicUrl;
  const c = counts(app);
  const feeds = new Map(app.feeds.list().map((f) => [f.id, f]));
  const folderIds = s.digest.folders;
  const pool = folderIds.length
    ? folderIds.flatMap((folderId) => app.entries.list({ view: "unread", folderId, limit: s.digest.limit }).items)
    : app.entries.list({ view: "unread", limit: s.digest.limit }).items;
  const fresh = pool.sort((a, b) => (b.publishedAt || b.createdAt) - (a.publishedAt || a.createdAt)).slice(0, s.digest.limit);
  const progress = app.entries.list({ view: "progress", limit: 3 }).items;
  const gone = app.archives.list({ status: "gone", limit: 5 }).items.filter((a) => a.goneAt && Date.now() - a.goneAt < 86_400_000 * 2);
  const date = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const lines = [`<b>松果 · ${esc(date)}</b>`, `未读 ${c.unread} · 今日新到 ${c.today} · 已藏 ${c.archived}`, ""];
  if (fresh.length) {
    lines.push("<b>新到</b>");
    for (const e of fresh) lines.push(`• <a href="${base}/entry/${e.id}">${esc(e.title)}</a> <i>${esc(feeds.get(e.feedId)?.title || "")}</i>`);
    lines.push("");
  }
  if (progress.length) {
    lines.push("<b>继续读</b>");
    for (const e of progress) lines.push(`• <a href="${base}/entry/${e.id}">${esc(e.title)}</a> · ${Math.round(e.progress * 100)}%`);
    lines.push("");
  }
  if (gone.length) {
    lines.push("<b>原文已消失，但你藏了</b>");
    for (const a of gone) lines.push(`• <a href="${base}/archive/${a.id}">${esc(a.title)}</a>`);
    lines.push("");
  }
  lines.push(`<a href="${base}/">打开松果</a>`);
  return lines.join("\n");
}

export async function sendDigest(app: App): Promise<void> {
  await sendTelegram(app, buildDigest(app));
  log.info("digest sent");
}
