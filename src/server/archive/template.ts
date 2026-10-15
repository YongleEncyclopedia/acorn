/** Standalone, offline-readable HTML page for an archived article. No scripts, no external requests. */
export interface TemplateData {
  title: string;
  url: string;
  site: string | null;
  author: string | null;
  publishedAt: number | null;
  capturedAt: number;
  method: string;
  contentHtml: string;
  words: number;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const METHOD: Record<string, string> = { fetch: "服务器抓取", browser: "浏览器快照", feed: "订阅源全文", import: "导入" };

export function renderArchivePage(d: TemplateData): string {
  const meta = [d.site, d.author, d.publishedAt ? fmt(d.publishedAt) : null].filter(Boolean).map((x) => esc(String(x))).join('<span class="dot">·</span>');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="Acorn 松果">
<meta name="acorn:source" content="${esc(d.url)}">
<meta name="acorn:captured" content="${new Date(d.capturedAt).toISOString()}">
<title>${esc(d.title)}</title>
<style>
:root{--paper:#f6f2ea;--ink:#211d17;--ink2:#5d574d;--ink3:#8d8679;--rule:#e2dacb;--accent:#8a5a2b;--seal:#b4372b;--code:#efe8da}
@media (prefers-color-scheme:dark){:root{--paper:#171513;--ink:#ebe4d6;--ink2:#aaa292;--ink3:#7b7468;--rule:#2f2b25;--accent:#d3a46e;--seal:#dd5a4c;--code:#221f1b}}
*{box-sizing:border-box}
html{background:var(--paper);color:var(--ink);-webkit-text-size-adjust:100%}
body{margin:0;font:18px/1.85 "Iowan Old Style","Palatino Linotype",Georgia,"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong",serif;text-rendering:optimizeLegibility;font-kerning:normal}
.wrap{max-width:40rem;margin:0 auto;padding:4.5rem 1.25rem 6rem}
header{position:relative;padding-bottom:1.75rem;margin-bottom:2.25rem;border-bottom:1px solid var(--rule)}
.site{font:600 .78rem/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 .9rem}
h1{font-size:2rem;line-height:1.3;margin:0 0 1rem;font-weight:700;letter-spacing:-.01em;text-wrap:balance}
.meta{font:.86rem/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;color:var(--ink2)}
.dot{margin:0 .5em;color:var(--ink3)}
.seal{position:absolute;right:0;top:-.5rem;width:3.4rem;height:3.4rem;border:2px solid var(--seal);border-radius:.45rem;color:var(--seal);display:grid;place-items:center;transform:rotate(-8deg);font:700 1.7rem/1 "Kaiti SC","STKaiti","KaiTi",serif;opacity:.88;box-shadow:inset 0 0 0 2px transparent}
.seal small{position:absolute;bottom:-1.35rem;left:50%;transform:translateX(-50%) rotate(8deg);font:600 .58rem/1 -apple-system,sans-serif;letter-spacing:.12em;white-space:nowrap;color:var(--ink3)}
article{hyphens:auto;overflow-wrap:break-word}
article p{margin:0 0 1.15em;text-align:justify}
article h2,article h3,article h4{line-height:1.35;margin:2em 0 .7em}
article h2{font-size:1.4rem}article h3{font-size:1.18rem}
article img,article video{max-width:100%;height:auto;display:block;margin:1.4em auto;border-radius:.35rem}
article figure{margin:1.6em 0}article figcaption{font-size:.85rem;color:var(--ink2);text-align:center;margin-top:-.6em}
article a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:.2em}
article blockquote{margin:1.4em 0;padding:.2em 0 .2em 1.1em;border-left:3px solid var(--rule);color:var(--ink2)}
article pre{background:var(--code);padding:1em 1.1em;border-radius:.4rem;overflow:auto;font-size:.82rem;line-height:1.6}
article code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
article :not(pre)>code{background:var(--code);padding:.1em .35em;border-radius:.25em}
article table{border-collapse:collapse;width:100%;font-size:.9rem;margin:1.4em 0;display:block;overflow:auto}
article th,article td{border:1px solid var(--rule);padding:.45em .7em}
article hr{border:0;border-top:1px solid var(--rule);margin:2.5em 0}
footer{margin-top:3.5rem;padding-top:1.4rem;border-top:1px solid var(--rule);font:.8rem/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:var(--ink3)}
footer a{color:var(--ink2);word-break:break-all}
@media (max-width:560px){body{font-size:17px}.wrap{padding-top:3rem}h1{font-size:1.6rem;padding-right:3.6rem}}
@media print{html{background:#fff}.seal{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style>
</head>
<body>
<div class="wrap">
<header>
  ${d.site ? `<p class="site">${esc(d.site)}</p>` : ""}
  <h1>${esc(d.title)}</h1>
  <div class="meta">${meta || esc(d.url)}</div>
  <div class="seal" aria-label="已存档">藏<small>${esc(fmt(d.capturedAt).slice(0, 10))}</small></div>
</header>
<article>
${d.contentHtml}
</article>
<footer>
  <div>存档于 ${esc(fmt(d.capturedAt))} · ${esc(METHOD[d.method] || d.method)} · 约 ${d.words.toLocaleString("zh-CN")} 字</div>
  <div>原文 <a href="${esc(d.url)}">${esc(d.url)}</a></div>
  <div>由 Acorn 松果 保存在你自己的电脑上</div>
</footer>
</div>
</body>
</html>
`;
}
