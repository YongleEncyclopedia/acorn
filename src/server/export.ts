/**
 * Take everything away: a ZIP of the whole library as plain files, streamed while it is built. The Markdown pack
 * holds every archived article (latest version) as Markdown with its images and attachments, one Markdown file of
 * highlights and notes per article, and the subscriptions as OPML. The full copy is the data directory itself:
 * every snapshot's offline page, original web page, MHTML, screenshot, plus the database.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { backup as sqliteBackup } from "node:sqlite";
import type { App } from "./app.ts";
import type { Highlight } from "../shared/types.ts";
import { ZipWriter } from "./util/zip.ts";
import { exportOpml } from "./feeds/opml.ts";
import { slugify } from "./util/text.ts";
import { VERSION } from "./config.ts";
import { logger } from "./util/log.ts";

const log = logger("export");

interface ArchiveRef {
  id: number;
  dir: string;
  title: string;
  url: string;
  entry_id: number | null;
}

/** Start building the ZIP; the stream ends when it is complete, or is destroyed with the error. */
export function exportStream(app: App, opts: { full: boolean }): PassThrough {
  const out = new PassThrough({ highWaterMark: 1 << 16 });
  build(app, opts.full, out).catch((err) => {
    log.warn("export failed", err);
    out.destroy(err);
  });
  return out;
}

async function build(app: App, full: boolean, out: PassThrough): Promise<void> {
  const zip = new ZipWriter(out);
  const archives = app.db.all<ArchiveRef>("select id, dir, title, url, entry_id from archives order by id");
  await zip.buffer("README.txt", readme(full));
  await zip.buffer("subscriptions.opml", exportOpml(app));
  for (const [name, text] of notesMarkdown(app, archives, full)) await zip.buffer(`notes/${name}`, text);
  if (full) {
    await addTree(zip, app.cfg.archiveDir, "archive");
    await addTree(zip, app.cfg.iconsDir, "icons");
    const tmp = path.join(app.cfg.cacheDir, `export-${process.pid}-${Date.now()}.db`);
    try {
      await sqliteBackup(app.db.raw, tmp);
      await zip.file("acorn.db", tmp);
    } finally {
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-journal`, { force: true });
    }
  } else {
    for (const a of archives) {
      const snap = app.archives.latestSnapshot(a.id);
      if (!snap) continue;
      const dir = path.join(app.cfg.archiveDir, snap.dir);
      const md = path.join(dir, "article.md");
      if (!existsSync(md)) continue;
      const leaf = path.posix.basename(a.dir);
      const base = `articles/${path.posix.dirname(a.dir)}`;
      // images and attachments move next to the Markdown file, into a folder of the same name
      const text = readFileSync(md, "utf8").replace(/(\]\(|src=")(assets|attachments)\//g, `$1${leaf}/$2/`);
      await zip.buffer(`${base}/${leaf}.md`, text, new Date(snap.captured_at));
      for (const sub of ["assets", "attachments"]) {
        const d = path.join(dir, sub);
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) await zip.file(`${base}/${leaf}/${sub}/${f}`, path.join(d, f));
      }
    }
  }
  await zip.finish();
}

async function addTree(zip: ZipWriter, root: string, prefix: string): Promise<void> {
  if (!existsSync(root)) return;
  for (const ent of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const abs = path.join(ent.parentPath, ent.name);
    try {
      await zip.file(`${prefix}/${path.relative(root, abs).split(path.sep).join("/")}`, abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted while we were busy
      throw err;
    }
  }
}

/** One Markdown file per article that has highlights, named like the article's folder so the two sort together. */
export function notesMarkdown(app: App, archives: ArchiveRef[], full: boolean): Map<string, string> {
  const byId = new Map(archives.map((a) => [a.id, a]));
  const byEntry = new Map(archives.filter((a) => a.entry_id).map((a) => [a.entry_id!, a]));
  const groups = new Map<string, { title: string; url: string | null; source: string | null; file: string; article: string | null; items: Highlight[] }>();
  for (const h of app.highlights.all()) {
    const a = (h.archiveId && byId.get(h.archiveId)) || (h.entryId && byEntry.get(h.entryId)) || null;
    const key = a ? `a${a.id}` : `e${h.entryId}`;
    let g = groups.get(key);
    if (!g) {
      const title = h.title || a?.title || "无标题";
      let article: string | null = null;
      if (a && full) {
        const snap = app.archives.latestSnapshot(a.id);
        if (snap) article = `../archive/${snap.dir}/article.md`;
      } else if (a) article = `../articles/${a.dir}.md`;
      g = { title, url: h.url || a?.url || null, source: h.source || null, file: a ? `${path.posix.basename(a.dir)}.md` : `${slugify(title)}-e${h.entryId}.md`, article, items: [] };
      groups.set(key, g);
    }
    g.items.push(h);
  }
  const when = (t: number) => new Date(t).toLocaleString("zh-CN", { hour12: false });
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    const lines = [`# ${g.title}`, ""];
    if (g.url) lines.push(`来源：<${g.url}>${g.source ? ` · ${g.source}` : ""}`);
    if (g.article) lines.push(`正文：[${path.posix.basename(g.article)}](${g.article})`);
    lines.push("");
    for (const h of g.items.sort((x, y) => x.createdAt - y.createdAt)) {
      lines.push(`> ${h.quote.replace(/\n/g, "\n> ")}`, "");
      if (h.note) lines.push(h.note, "");
      lines.push(`<sub>${when(h.createdAt)}</sub>`, "");
    }
    out.set(g.file, lines.join("\n"));
  }
  return out;
}

function readme(full: boolean): string {
  const common = `松果 Acorn ${VERSION} 导出 · ${new Date().toLocaleString("zh-CN", { hour12: false })}

  notes/<标题>-<id>.md       每篇文章的划线与批注（Markdown）
  subscriptions.opml         订阅列表，任何 RSS 阅读器都能导入
`;
  return full
    ? `${common}
  archive/<年>/<月>/<标题>-<id>/<时间戳>/
      article.html           离线阅读页，双击就能看
      article.md             Markdown
      source.html            原始网页
      page.mhtml             整页快照（浏览器入藏时）
      screenshot.png         整页截图（浏览器入藏时）
      assets/ attachments/   图片、附件
      meta.json              原文地址、标题、作者、发布时间、存档方式、内容哈希
  icons/                     订阅源图标
  acorn.db                   数据库：索引、已读状态、批注、设置

这个文件夹就是一个完整的松果数据目录。换台电脑恢复：解压，然后用
  ACORN_DATA_DIR=<这个文件夹> npm start
启动松果即可。
`
    : `${common}
  articles/<年>/<月>/<标题>-<id>.md
                             每篇存档的 Markdown（最新版本）；图片在同名文件夹的 assets/ 里，附件在 attachments/
                             整个 articles/ 可以直接放进 Obsidian、Logseq 等笔记软件

需要离线阅读页、原始网页和数据库的话，在松果里选「完整副本」。
`;
}
