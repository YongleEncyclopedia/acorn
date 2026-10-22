/**
 * acorn — command-line interface for Acorn 松果.
 * Designed for both people and agents: every command accepts --json for machine-readable output.
 * Run `acorn help` for the list of commands.
 */
import { readFileSync } from "node:fs";
import { createClient, unproxify, AcornError } from "../client/client.ts";
import { toMarkdown } from "../server/content/markdown.ts";
import { loadConfig } from "../server/config.ts";
import type { EntryView, FeedKind } from "../shared/types.ts";

const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const args: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--") && !["json", "unread", "browser", "gone", "send", "markdown", "all", "star", "unstar", "read"].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else args.push(a);
}
const json = !!flags.json;
const tty = process.stdout.isTTY && !json;
const c = (code: number) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2);
const bold = c(1);
const red = c(31);
const brown = c(33);

function out(data: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

function when(t: number | null | undefined): string {
  if (!t) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const HELP = `松果 Acorn 命令行

用法: acorn <命令> [参数] [--json]

阅读
  status                         概览：未读、今日、存档、失败的订阅源
  unread [--feed ID] [--limit N] 未读文章
  list [--view today|unread|starred|progress|all|archived] [--feed ID] [--limit N]
  read <文章ID> [--no-mark]      以 Markdown 输出全文（默认标为已读）
  mark <ID...> [--unread]        标为已读 / 未读
  star <ID> [--unstar]           加入 / 移出稍后读（默认会自动入藏）
  search <关键词>                 搜索文章、存档、批注

订阅
  feeds                          列出订阅源
  add <网址|rsshub://路由|plugin:ID> [--folder 名称] [--title 名称] [--kind feed|rsshub|html|plugin] [--auto-archive]
  preview <网址> [--kind html]    预览不订阅；网页会自动识别文章列表
  refresh [订阅源ID|--all]       立即刷新
  rm <订阅源ID>                   取消订阅
  opml-import <文件> | opml-export
  wechat [sync] [--url 地址]      微信公众号（we-mp-rss）：查看 / 立即同步 / 设置地址

存档
  archive <网址|文章ID> [--browser] [--tag 标签]   入藏（--browser 用你登录过的浏览器）
  pending                        等你在浏览器里完成验证的入藏任务
  resume <空间ID>                 验证完成后继续入藏
  from-browser <空间ID> [--url 网址]  把 ego 浏览器某个空间里已经打开的页面入藏
  archives [--gone] [--tag 标签] [--q 关键词] [--limit N]
  show-archive <存档ID>           输出存档全文 Markdown 与文件位置
  recheck <存档ID>                检查原文是否还在
  notes [--q 关键词]              批注

其他
  login-link                     在终端里显示二维码，手机扫一下就登录（10 分钟内有效，只能用一次）
  digest [--send]                预览 / 发送 Telegram 摘要
  passwd <新密码>                 直接修改密码（服务可以不运行）
  help

环境变量: ACORN_URL（默认 http://127.0.0.1:7700）、ACORN_TOKEN（默认读取 data/.cli-token）`;

async function main(): Promise<void> {
  const cmd = args.shift() || "help";
  if (cmd === "help" || flags.help) return console.log(HELP);

  if (cmd === "passwd") {
    const pw = args[0];
    if (!pw || pw.length < 6) throw new Error("新密码至少 6 位");
    const { createApp } = await import("../server/app.ts");
    const { setPassword } = await import("../server/api/auth.ts");
    const app = createApp(loadConfig(process.env, { scheduler: false }));
    setPassword(app, pw);
    app.db.close();
    return console.log("密码已修改，所有设备需要重新登录。");
  }

  const api = createClient();

  switch (cmd) {
    case "status": {
      const [counts, stats, feeds] = await Promise.all([api.counts(), api.stats(), api.feeds()]);
      const failing = feeds.filter((f) => f.errorCount > 0);
      return out({ counts, stats, failing: failing.map((f) => ({ id: f.id, title: f.title, error: f.lastError })) }, () => {
        console.log(`${bold("松果")} ${dim(api.baseUrl)}`);
        console.log(`未读 ${bold(counts.unread)} · 今日 ${counts.today} · 稍后读 ${counts.starred} · 在读 ${counts.inProgress}`);
        console.log(`已藏 ${bold(counts.archived)} · 原文已消失 ${counts.gone ? red(counts.gone) : 0} · 批注 ${counts.highlights}`);
        console.log(`订阅源 ${counts.feeds}${failing.length ? ` · ${red(`${failing.length} 个失败`)}` : ""}`);
        for (const f of failing) console.log(`  ${red("✗")} #${f.id} ${f.title} ${dim(f.lastError || "")}`);
      });
    }
    case "unread":
    case "list": {
      const view = (cmd === "unread" ? "unread" : (flags.view as EntryView) || "all") as EntryView;
      const page = await api.entries({ view, feed: flags.feed ? Number(flags.feed) : undefined, limit: Number(flags.limit || 20) });
      const feeds = new Map((await api.feeds()).map((f) => [f.id, f.title]));
      return out(page.items.map((e) => ({ ...e, feed: feeds.get(e.feedId) })), () => {
        for (const e of page.items) {
          const flagsStr = `${e.starredAt ? brown("★") : " "}${e.archiveId ? red("藏") : "  "}`;
          console.log(`${dim(String(e.id).padStart(5))} ${flagsStr} ${e.readAt ? dim(e.title) : bold(e.title)}`);
          console.log(`        ${dim(`${feeds.get(e.feedId) || ""} · ${when(e.publishedAt || e.createdAt)}`)}`);
        }
        if (!page.items.length) console.log(dim("（没有文章）"));
      });
    }
    case "read": {
      const id = Number(args[0]);
      let e = await api.entry(id);
      if (!e.hasFullContent && e.url && flags.full) e = (await api.fulltext(id)).entry;
      if (!flags["no-mark"] && !e.readAt) await api.patchEntry(id, { read: true });
      const md = toMarkdown(unproxify(e.content));
      return out({ ...e, content: undefined, feedContent: undefined, markdown: md }, () => {
        console.log(`# ${e.title}\n`);
        console.log(dim(`${e.author ? `${e.author} · ` : ""}${when(e.publishedAt)} · ${e.url || ""}`));
        console.log("");
        console.log(md);
        if (e.highlights.length) {
          console.log(bold("\n批注"));
          for (const h of e.highlights) console.log(`> ${h.quote}${h.note ? `\n  ${dim(h.note)}` : ""}`);
        }
      });
    }
    case "mark": {
      const ids = args.map(Number).filter(Boolean);
      const r = await api.mark({ ids, read: !flags.unread });
      return out(r, () => console.log(`已更新 ${r.changed} 篇`));
    }
    case "star": {
      const r = await api.patchEntry(Number(args[0]), { starred: !flags.unstar });
      return out(r, () => console.log(flags.unstar ? "已移出稍后读" : "已加入稍后读（会自动入藏）"));
    }
    case "search": {
      const r = await api.search(args.join(" "));
      return out(r, () => {
        if (r.entries.length) console.log(bold("文章"));
        for (const e of r.entries) console.log(`  ${dim(String(e.id).padStart(5))} ${e.title}`);
        if (r.archives.length) console.log(bold("存档"));
        for (const a of r.archives) console.log(`  ${dim(String(a.id).padStart(5))} ${a.title} ${dim(a.site || "")}`);
        if (r.highlights.length) console.log(bold("批注"));
        for (const h of r.highlights) console.log(`  ${dim(String(h.id).padStart(5))} 「${h.quote.slice(0, 60)}」 ${dim(h.title || "")}`);
        if (!r.entries.length && !r.archives.length && !r.highlights.length) console.log(dim("没有结果"));
      });
    }
    case "feeds": {
      const feeds = await api.feeds();
      return out(feeds, () => {
        for (const f of feeds) {
          const state = f.errorCount ? red("✗") : f.paused ? dim("⏸") : "·";
          console.log(`${dim(String(f.id).padStart(4))} ${state} ${bold(f.title)} ${dim(`[${f.kind}] ${f.unread}/${f.total}`)}`);
          console.log(`       ${dim(f.url)}${f.lastError ? `\n       ${red(f.lastError)}` : ""}`);
        }
      });
    }
    case "add": {
      try {
        const r = await api.addFeed({
          input: args[0],
          kind: flags.kind as FeedKind | undefined,
          title: flags.title as string | undefined,
          folderName: flags.folder as string | undefined,
          autoArchive: !!flags["auto-archive"],
        });
        return out(r, () => console.log(r.existed ? `已经订阅过：#${r.feed.id} ${r.feed.title}` : `已订阅 #${r.feed.id} ${bold(r.feed.title)}，收到 ${r.added} 篇${r.error ? red(`（${r.error}）`) : ""}`));
      } catch (err) {
        const e = err as AcornError;
        const preview = e.data?.preview as { candidates?: { url: string; title: string }[] } | undefined;
        if (preview?.candidates?.length) {
          return out({ error: e.message, candidates: preview.candidates }, () => {
            console.log(e.message);
            for (const c2 of preview.candidates!) console.log(`  ${c2.title || ""} ${dim(c2.url)}`);
          });
        }
        throw err;
      }
    }
    case "preview": {
      const r = await api.preview(args[0], flags.kind as FeedKind | undefined);
      return out(r, () => {
        console.log(`${bold(r.title || r.url)} ${dim(`[${r.kind}] ${r.resolvedUrl}`)}`);
        if (r.suggestedRule) console.log(`识别出的列表规则: ${JSON.stringify(r.suggestedRule)}`);
        for (const c2 of r.candidates) console.log(`  订阅源候选: ${c2.title} ${dim(c2.url)}`);
        for (const it of r.items) console.log(`  ${dim(when(it.publishedAt).slice(0, 10) || "          ")} ${it.title}`);
      });
    }
    case "refresh": {
      if (flags.all || !args[0]) {
        const r = await api.refreshAll();
        return out(r, () => console.log(`已排队刷新 ${r.queued} 个订阅源`));
      }
      const r = await api.refreshFeed(Number(args[0]));
      return out(r, () => console.log(r.error ? red(`失败：${r.error}`) : `新到 ${r.added} 篇`));
    }
    case "rm": {
      const r = await api.deleteFeed(Number(args[0]));
      return out(r, () => console.log(r.ok ? "已取消订阅" : "没有这个订阅源"));
    }
    case "opml-export":
      return console.log(await api.exportOpml());
    case "opml-import": {
      const r = await api.importOpml(readFileSync(args[0], "utf8"));
      return out(r, () => console.log(`导入 ${r.added} 个，跳过 ${r.skipped} 个，新建分组 ${r.folders} 个`));
    }
    case "archive": {
      const target = args[0];
      const body = /^\d+$/.test(target) ? { entryId: Number(target) } : { url: target };
      const tags = flags.tag ? String(flags.tag).split(/[,，]/) : undefined;
      let r;
      try {
        r = await api.capture({ ...body, method: flags.browser ? "browser" : "fetch", tags });
      } catch (err) {
        const e = err as AcornError;
        if (e.status === 423 && e.data?.spaceId) {
          return out({ verify: true, spaceId: e.data.spaceId, message: e.message }, () => {
            console.log(brown(e.message));
            console.log(`完成验证后运行：acorn resume ${e.data.spaceId}`);
          });
        }
        throw err;
      }
      return out(r, () => {
        console.log(r.unchanged ? `已经藏过，内容没有变化：#${r.archiveId}` : `已入藏 #${r.archiveId} ${bold(r.title)}`);
        for (const w of r.warnings) console.log(dim(`  · ${w}`));
      });
    }
    case "login-link": {
      const l = await api.loginLink();
      const [first, ...rest] = l.origins;
      const qr = first && !json ? await terminalQr(`${first.origin}${l.path}`) : "";
      return out(l, () => {
        if (!first) return console.log(red("松果只在本机监听（ACORN_HOST=127.0.0.1），手机连不上。"));
        console.log(qr);
        console.log(`${bold(first.label.replace(/ .*/, ""))} ${first.origin}${l.path}`);
        for (const o of rest) console.log(`${dim(o.label.replace(/ .*/, ""))} ${o.origin}${l.path}`);
        console.log(dim("10 分钟内有效，只能用一次。"));
      });
    }
    case "wechat": {
      if (typeof flags.url === "string") {
        const s = await api.settings();
        await api.patchSettings({ wechatBridge: { ...s.wechatBridge, url: flags.url } });
      }
      if (args[0] === "sync") {
        const r = await api.wechatSync();
        return out(r, () => {
          console.log(`we-mp-rss 里共 ${r.total} 个公众号，新订阅 ${r.added.length} 个`);
          for (const a of r.added) console.log(`  + ${a.title} ${dim(`#${a.feedId}`)}`);
          for (const f of r.failed) console.log(red(`  × ${f.title}：${f.error}`));
        });
      }
      const st = await api.wechatBridge();
      return out(st, () => {
        if (!st.url) return console.log(dim("还没有连接 we-mp-rss：acorn wechat --url http://127.0.0.1:8001"));
        console.log(`${bold("we-mp-rss")} ${st.url} · ${st.accounts.length} 个公众号`);
        for (const a of st.accounts) console.log(`  ${a.feedId ? brown("●") : dim("○")} ${a.title} ${dim(a.feedId ? `订阅源 #${a.feedId}` : "未同步")}`);
      });
    }
    case "pending": {
      const list = await api.pendingVerify();
      return out(list, () => {
        if (!list.length) return console.log(dim("没有等待验证的任务"));
        for (const p of list) console.log(`空间 ${bold(p.spaceId)} · ${p.reason} · ${p.title || p.url} ${dim(when(p.createdAt))}`);
      });
    }
    case "resume":
    case "from-browser": {
      const spaceId = Number(args[0]);
      if (!spaceId) throw new Error("需要 ego-browser 空间 ID");
      const r = cmd === "resume" ? await api.resumeCapture(spaceId) : await api.captureOpenTab(spaceId, flags.url as string | undefined);
      return out(r, () => console.log(`已入藏 ${bold(r.title)}`));
    }
    case "archives": {
      const page = await api.archives({ q: flags.q as string | undefined, status: flags.gone ? "gone" : undefined, tag: flags.tag as string | undefined, limit: Number(flags.limit || 20) });
      return out(page.items, () => {
        for (const a of page.items) {
          const status = a.sourceStatus === "gone" ? red("原文已消失") : a.sourceStatus === "changed" ? brown("原文改过") : "";
          console.log(`${dim(String(a.id).padStart(5))} ${bold(a.title)} ${status}`);
          console.log(`       ${dim(`${a.site || ""} · 藏于 ${when(a.createdAt)} · ${a.snapshotCount} 个版本${a.tags.length ? ` · #${a.tags.join(" #")}` : ""}`)}`);
        }
      });
    }
    case "show-archive": {
      const a = await api.archive(Number(args[0]));
      const md = toMarkdown(unproxify(a.content));
      return out({ ...a, content: undefined, markdown: md }, () => {
        console.log(`# ${a.title}\n`);
        console.log(dim(`原文 ${a.url} · ${a.sourceStatus}`));
        console.log(dim(`文件夹 ${a.absolutePath}`));
        console.log("");
        console.log(md);
      });
    }
    case "recheck": {
      const r = await api.recheck(Number(args[0]));
      return out(r, () => console.log(`${r.status}${r.reason ? `：${r.reason}` : ""}`));
    }
    case "notes": {
      const page = await api.highlights(flags.q as string | undefined, Number(flags.limit || 30));
      return out(page.items, () => {
        for (const h of page.items) {
          console.log(`「${h.quote}」`);
          if (h.note) console.log(`  ${h.note}`);
          console.log(dim(`  —— ${h.title || ""} · ${when(h.createdAt)}\n`));
        }
      });
    }
    case "digest": {
      if (flags.send) {
        await api.digestSend();
        return console.log("已发送");
      }
      const r = await api.digestPreview();
      return out(r, () => console.log(r.html.replace(/<[^>]+>/g, "")));
    }
    default:
      console.error(`不认识的命令：${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  if (json) console.log(JSON.stringify({ error: err.message }));
  else console.error(red(`✗ ${err.message}`));
  process.exitCode = 1;
});

/** A QR code drawn with half blocks, black on white so it scans on dark terminals too. */
async function terminalQr(text: string): Promise<string> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines: string[] = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = "";
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n");
}
