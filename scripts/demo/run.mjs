// The demo library, for screenshots: a fresh Acorn filled with the fictional sources in content.mjs.
//
//   npm run build && node scripts/demo/run.mjs [--port 7733] [--data tmp/demo-library]
//
// Then open http://127.0.0.1:7733 (password: acorn). The sites, their pictures and the translation model are
// all served by this script: Acorn runs in this process, and its requests for *.example addresses are answered
// here instead of going out. Nothing reaches the network, and the library it builds is thrown away next time.
//
// For screenshots, put the library somewhere that does not name you: an archive's side panel shows its folder's
// full path (e.g. --data /Users/Shared/Acorn). The script only ever empties a folder it made itself.
import http from "node:http";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { serve } from "@hono/node-server";
import { ARTICLES, HIGHLIGHTS, IMAGES, KEY_POINTS, SITES, TRANSLATIONS } from "./content.mjs";
import { squirclePath } from "../../src/shared/brand.ts";
import { loadConfig, ROOT } from "../../src/server/config.ts";
import { createApp, ensureCliToken } from "../../src/server/app.ts";
import { createHttp } from "../../src/server/api/http.ts";
import { setPassword } from "../../src/server/api/auth.ts";

const { values: args } = parseArgs({ options: { port: { type: "string", default: "7733" }, data: { type: "string", default: "tmp/demo-library" } } });
const PORT = Number(args.port);
const DATA = path.resolve(ROOT, args.data);
const PASSWORD = "acorn";
const HOUR = 3_600_000;
const NOW = Date.now();
process.env.ACORN_SILENT = "1";

// ───────────────────────── the fictional web ─────────────────────────

const sites = Object.fromEntries(Object.entries(SITES).map(([key, s]) => [s.host, { key, ...s }]));
const gone = new Set();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const postUrl = (a) => `http://${SITES[a.site].host}/posts/${a.id}`;

function feedXml(site) {
  const items = ARTICLES.filter((a) => SITES[a.site].host === site.host).sort((a, b) => a.hoursAgo - b.hoursAgo);
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${esc(site.title)}</title><link>http://${site.host}/</link><description>${esc(site.description)}</description>
${items
  .map(
    (a) => `<item><title>${esc(a.title)}</title><link>${postUrl(a)}</link><guid>${postUrl(a)}</guid><dc:creator>${esc(a.author)}</dc:creator>
<pubDate>${new Date(NOW - a.hoursAgo * HOUR).toUTCString()}</pubDate><content:encoded><![CDATA[${a.html}]]></content:encoded></item>`,
  )
  .join("\n")}
</channel></rss>`;
}

const page = (site, title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)} - ${esc(site.title)}</title>
<meta property="og:site_name" content="${esc(site.title)}"><link rel="icon" href="/icon.png"></head>
<body><header><a href="/">${esc(site.title)}</a></header>${body}<footer>© ${esc(site.title)}</footer></body></html>`;

function landscape({ sky, sun, hills }, w = 1600, h = 1000) {
  const layers = hills
    .map((color, i) => {
      const base = h * (0.5 + i * 0.12);
      const amp = h * (0.07 - i * 0.008);
      const pts = [];
      for (let x = 0; x <= w; x += 20) {
        const t = x / w;
        const y = base - amp * (Math.sin(t * Math.PI * (1.3 + i * 0.45) + i * 1.7) * 0.7 + Math.sin(t * Math.PI * (3.1 + i) + i) * 0.3);
        pts.push(`${x},${y.toFixed(1)}`);
      }
      return `<path d="M0,${h} L${pts.join(" L")} L${w},${h} Z" fill="${color}"/>`;
    })
    .join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[0]}"/></linearGradient>
<radialGradient id="g"><stop offset="0" stop-color="${sun}" stop-opacity=".9"/><stop offset="1" stop-color="${sun}" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${h * 0.3}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${h * 0.085}" fill="${sun}"/>${layers}</svg>`);
}

const images = {};
for (const [name, spec] of Object.entries(IMAGES)) images[name] = await sharp(landscape(spec)).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
const icons = {};
for (const s of Object.values(SITES)) {
  const latin = /^[A-Za-z]$/.test(s.icon.char);
  icons[s.host] = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100"><path d="${squirclePath()}" fill="${s.icon.bg}"/>
<text x="50" y="${latin ? 68 : 67}" text-anchor="middle" font-family="${latin ? "Georgia, serif" : "PingFang SC, Hiragino Sans GB, sans-serif"}" font-size="${latin ? 56 : 50}" font-weight="600" fill="#fff">${s.icon.char}</text></svg>`),
  )
    .png()
    .toBuffer();
}
// a one-page PDF, for the notice's attachment
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

/** The model the demo's translation settings point at: it knows the demo's articles and nothing else. */
function fakeModel(body) {
  const system = body.messages.find((m) => m.role === "system")?.content || "";
  const user = body.messages.find((m) => m.role === "user")?.content || "";
  if (/key points/i.test(system)) {
    const id = /分散贮藏/.test(user) ? "forgotten-acorns" : /jay/i.test(user) ? "accidental-foresters" : null;
    const points = id ? KEY_POINTS[id] : ["这是演示用的模型，只认识演示库里的两篇文章。"];
    return points.map((t) => `- ${t}`).join("\n");
  }
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const known = new Map(Object.entries(TRANSLATIONS).map(([k, v]) => [norm(k), v]));
  return [...user.matchAll(/\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n\n\[\[\d+\]\]|$)/g)].map(([, n, text]) => `[[${n}]] ${known.get(norm(text)) || norm(text)}`).join("\n\n");
}

const fixtures = http.createServer(async (req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  const m = (req.url || "").match(/^\/__site\/([^/]+)(\/[^?]*)?/);
  if (!m) return send(404, "text/plain", "not found");
  const [, host, p = "/"] = m;
  if (host === "translate.example") {
    if (p.endsWith("/models")) return send(200, "application/json", JSON.stringify({ data: [{ id: "qwen3:14b" }] }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    return send(200, "application/json", JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: fakeModel(body) } }] }));
  }
  const site = sites[host];
  if (!site) return send(404, "text/plain", "no such site");
  if (p === "/feed.xml") return send(200, "application/rss+xml; charset=utf-8", feedXml(site));
  if (p === "/icon.png") return send(200, "image/png", icons[host]);
  if (p === "/" || p === "") return send(200, "text/html; charset=utf-8", page(site, site.title, `<h1>${esc(site.title)}</h1><p>${esc(site.description)}</p>`));
  const img = p.match(/^\/img\/(\w+)\.jpg$/);
  if (img && images[img[1]]) return send(200, "image/jpeg", images[img[1]]);
  if (p === "/files/exam-schedule.pdf") return send(200, "application/pdf", PDF);
  const post = p.match(/^\/posts\/([\w-]+)$/);
  const a = post && ARTICLES.find((x) => x.id === post[1] && SITES[x.site].host === host);
  if (a && !gone.has(a.id)) return send(200, "text/html; charset=utf-8", page(site, a.title, `<article><h1>${esc(a.title)}</h1><p class="byline">${esc(a.author)}</p>${a.html}</article>`));
  return send(404, "text/html; charset=utf-8", page(site, "页面不存在", "<h1>404</h1><p>页面不存在或已被删除</p>"));
});
await new Promise((r) => fixtures.listen(0, "127.0.0.1", r));
const FIXTURES = `http://127.0.0.1:${fixtures.address().port}/__site`;

// Acorn's requests for the fictional sites come here; everything else would go out as usual (nothing does).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url);
  if (!u.hostname.endsWith(".example")) return realFetch(input, init);
  const res = await realFetch(`${FIXTURES}/${u.hostname}${u.pathname}${u.search}`, init);
  // report the address that was asked for, so nothing in the library mentions this machine
  Object.defineProperty(res, "url", { value: url });
  return res;
};

// ───────────────────────── the library ─────────────────────────

// the library is rebuilt on every run, so its folder is emptied first: only ever one that this script made
const MARK = path.join(DATA, ".acorn-demo");
if (existsSync(DATA) && readdirSync(DATA).length && !existsSync(MARK)) {
  console.error(`${DATA} 不是演示库（里面没有 .acorn-demo），不会清空它。请换一个 --data。`);
  process.exit(1);
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
writeFileSync(MARK, "This folder is rebuilt by scripts/demo/run.mjs every time it runs.\n");
const app = createApp(loadConfig({ ACORN_DATA_DIR: DATA, ACORN_PORT: String(PORT), ACORN_EGO_BROWSER: "not-for-the-demo" }, { scheduler: false }));
setPassword(app, PASSWORD);
const token = ensureCliToken(app);
const web = createHttp(app);
async function call(method, p, body) {
  const res = await web.request(p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

await call("PATCH", "/api/settings", {
  archiveOnStar: true,
  archiveOnHighlight: true,
  recheckDays: 0,
  translate: { provider: "openai", baseUrl: "http://translate.example/v1", model: "qwen3:14b", apiKey: "demo", targetLang: "zh-CN", auto: false, titles: true, display: "bilingual" },
});
const FOLDERS = { squirrel: "阅读", field: "阅读", daily: "本地", campus: "学校" };
for (const [key, s] of Object.entries(SITES)) await call("POST", "/api/feeds", { input: `http://${s.host}/feed.xml`, folderName: FOLDERS[key] });
await app.jobs.idle();

const entries = (await call("GET", "/api/entries?view=all&limit=200")).items;
const entry = (id) => {
  const a = ARTICLES.find((x) => x.id === id);
  const e = entries.find((x) => x.title === a.title);
  if (!e) throw new Error(`entry for ${id} not found`);
  return e;
};
for (const id of ["cold-week", "library-hours", "slow-field-guide", "study-lamp", "book-market"]) await call("PATCH", `/api/entries/${entry(id).id}`, { read: true });
await call("PATCH", `/api/entries/${entry("slow-reading").id}`, { progress: 0.46 });
await call("PATCH", `/api/entries/${entry("accidental-foresters").id}`, { progress: 0.18 });
for (const id of ["winter-stores", "accidental-foresters"]) await call("PATCH", `/api/entries/${entry(id).id}`, { starred: true });
for (const h of HIGHLIGHTS) await call("POST", "/api/highlights", { entryId: entry(h.article).id, quote: h.quote, prefix: "", suffix: "", note: h.note, color: h.color });
for (const id of ["link-rot", "ginkgo", "exam-schedule", "book-market", "slow-reading"]) await call("POST", "/api/archives", { entryId: entry(id).id, wait: true });
await app.jobs.idle();

const archives = (await call("GET", "/api/archives?limit=50")).items;
const archive = (id) => archives.find((x) => x.title === ARTICLES.find((a) => a.id === id).title);
const TAGS = { "forgotten-acorns": ["阅读", "自然"], "winter-stores": ["归档"], "link-rot": ["归档", "English"], "accidental-foresters": ["自然", "English"], "exam-schedule": ["学校"], ginkgo: ["本地"] };
for (const [id, tags] of Object.entries(TAGS)) {
  const a = archive(id);
  if (a) await call("PATCH", `/api/archives/${a.id}`, { tags });
}
// one original disappears after it was kept
gone.add("link-rot");
await call("POST", `/api/archives/${archive("link-rot").id}/recheck`);
await app.jobs.idle();

// Everything above happened in the last few seconds. Spread it over the days a reader would have taken: each
// copy kept a little after its article came out, the notes made this afternoon, the lost original noticed today.
const KEPT_HOURS_AGO = { "forgotten-acorns": 2, ginkgo: 4, "accidental-foresters": 8, "winter-stores": 20, "exam-schedule": 25, "link-rot": 28, "book-market": 40, "slow-reading": 50 };
for (const [id, hours] of Object.entries(KEPT_HOURS_AGO)) {
  const a = archive(id);
  if (!a) continue;
  const t = NOW - hours * HOUR;
  app.db.run("update archives set created_at = ?, updated_at = ?, source_checked_at = ? where id = ?", t, t, NOW - HOUR, a.id);
  app.db.run("update snapshots set captured_at = ? where archive_id = ?", t, a.id);
}
app.db.run("update archives set gone_at = ?, source_checked_at = ? where id = ?", NOW - 3 * HOUR, NOW - 3 * HOUR, archive("link-rot").id);
app.db.run("update highlights set created_at = ?, updated_at = ?", NOW - 2 * HOUR, NOW - 2 * HOUR);

const counts = await call("GET", "/api/counts");
serve({ fetch: web.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`演示库已就绪：http://127.0.0.1:${PORT}  密码 ${PASSWORD}`);
  console.log(`  ${entries.length} 篇文章，${counts.unread} 篇未读，${counts.archived} 份存档（${counts.gone} 份原文已消失），${counts.highlights} 条批注`);
  const where = path.relative(ROOT, DATA);
  console.log(`  数据在 ${where.startsWith("..") ? DATA : where}，下次运行会重建。Ctrl-C 结束。`);
});
