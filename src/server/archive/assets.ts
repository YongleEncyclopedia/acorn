import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { httpGet } from "../util/http.ts";
import { sha1 } from "../util/text.ts";
import { originOf } from "../util/url.ts";
import { ruleFor } from "../content/rules/index.ts";
import type { Mhtml } from "./mhtml.ts";
import { ATTACHMENT_RE } from "../content/extract.ts";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/heic": "heic",
};

/** Detect the image type from magic bytes when the server lies or omits Content-Type. */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(4, 12).toString("latin1").startsWith("ftypavi")) return "image/avif";
  if (b.subarray(4, 12).toString("latin1").startsWith("ftyphei") || b.subarray(4, 12).toString("latin1").startsWith("ftypmif")) return "image/heic";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  const head = b.subarray(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

export interface AssetResult {
  html: string;
  files: { url: string; file: string; bytes: number; type: string }[];
  attachments: { url: string; file: string; bytes: number; name: string }[];
  failed: string[];
  leadFile: string | null;
  bytes: number;
}

interface Options {
  pageUrl: string;
  /** Absolute snapshot directory; assets go to <dir>/assets. */
  dir: string;
  mhtml?: Mhtml | null;
  leadImage?: string | null;
  userAgent: string;
  maxAssets?: number;
}

function bestFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, desc = "1x"] = part.trim().split(/\s+/, 2);
    const n = parseFloat(desc) || 1;
    const score = desc.endsWith("w") ? n : n * 1000;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url || null;
}

async function download(url: string, opts: Options): Promise<{ body: Buffer; type: string } | null> {
  const fromMhtml = opts.mhtml?.resources.get(url);
  if (fromMhtml?.body.length) {
    const type = fromMhtml.type.startsWith("image/") ? fromMhtml.type : sniffImage(fromMhtml.body);
    if (type) return { body: fromMhtml.body, type };
  }
  if (url.startsWith("data:")) return null;
  const rule = ruleFor(opts.pageUrl);
  const referers: (string | null)[] = rule?.imageReferer ? [rule.imageReferer(opts.pageUrl), null] : [originOf(opts.pageUrl) + "/", null];
  for (const referer of [...new Set(referers)]) {
    try {
      const res = await httpGet(url, { userAgent: opts.userAgent, referer, accept: "image/avif,image/webp,image/*,*/*;q=0.8", maxBytes: 30 * 1024 * 1024, timeoutMs: 30_000 });
      if (!res.ok) continue;
      const declared = res.contentType.split(";")[0].trim().toLowerCase();
      const type = declared.startsWith("image/") ? declared : sniffImage(res.body);
      if (!type) continue;
      return { body: res.body, type: sniffImage(res.body) || type };
    } catch {
      /* try the next referer */
    }
  }
  return null;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

function filenameFrom(res: { headers: Headers }, url: string, text: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  if (star) {
    try {
      return safeName(decodeURIComponent(star.replace(/^"|"$/g, "")));
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  if (plain) {
    // Many Chinese servers send GBK/UTF-8 bytes as latin1 here.
    const fixed = Buffer.from(plain, "latin1").toString("utf8");
    return safeName(/\uFFFD/.test(fixed) ? plain : fixed);
  }
  const t = text.trim().replace(/^附件[【\[:：\s]*/, "").replace(/[】\]]$/, "");
  if (/\.[a-z0-9]{2,5}$/i.test(t)) return safeName(t);
  const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  return safeName(last || t || "attachment");
}

/** Download linked attachments (PDF, Office files, archives) so notices keep their files after the page is gone. */
async function localizeAttachments(root: Element, opts: Options): Promise<AssetResult["attachments"]> {
  const out: AssetResult["attachments"] = [];
  const anchors = [...root.querySelectorAll("a[href]")].filter((a) => /^https?:/i.test(a.getAttribute("href") || "") && ATTACHMENT_RE.test(`${a.getAttribute("href")} ${a.textContent}`));
  if (!anchors.length) return out;
  const dir = path.join(opts.dir, "attachments");
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  for (const a of anchors.slice(0, 20)) {
    const url = a.getAttribute("href")!;
    try {
      const res = await httpGet(url, { userAgent: opts.userAgent, referer: opts.pageUrl, maxBytes: 60 * 1024 * 1024, timeoutMs: 60_000 });
      if (!res.ok || /text\/html/i.test(res.contentType) || res.body.length < 64) continue;
      let name = filenameFrom(res, res.url, a.textContent || "");
      while (used.has(name)) name = name.replace(/(\.[^.]+)?$/, (ext) => `-1${ext || ""}`);
      used.add(name);
      writeFileSync(path.join(dir, name), res.body);
      a.setAttribute("href", `attachments/${encodeURIComponent(name)}`);
      a.setAttribute("data-acorn-href", url);
      out.push({ url, file: name, bytes: res.body.length, name });
    } catch {
      /* keep the remote link */
    }
  }
  return out;
}

/**
 * Download every image referenced by the article (and the lead image) into <dir>/assets,
 * rewriting the HTML to relative paths. Failed images keep their remote URL.
 */
export async function localizeAssets(contentHtml: string, opts: Options): Promise<AssetResult> {
  const { document } = parseHTML(`<!doctype html><html><body><div id="__acorn">${contentHtml}</div></body></html>`);
  const root = document.getElementById("__acorn")!;
  const assetsDir = path.join(opts.dir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const targets = new Map<string, { el: Element; attr: string }[]>();
  const want = (url: string | null, el: Element, attr: string) => {
    if (!url || !/^https?:/i.test(url)) return;
    if (!targets.has(url)) targets.set(url, []);
    targets.get(url)!.push({ el, attr });
  };
  for (const img of root.querySelectorAll("img")) {
    const src = bestFromSrcset(img.getAttribute("srcset")) || img.getAttribute("src");
    want(src, img, "src");
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
  }
  for (const source of root.querySelectorAll("picture source")) source.remove();
  for (const v of root.querySelectorAll("video[poster]")) want(v.getAttribute("poster"), v, "poster");

  const urls = [...targets.keys()].slice(0, opts.maxAssets ?? 400);
  if (opts.leadImage && /^https?:/i.test(opts.leadImage) && !targets.has(opts.leadImage)) urls.push(opts.leadImage);

  const files: AssetResult["files"] = [];
  const failed: string[] = [];
  const done = new Map<string, string>();
  let bytes = 0;
  let index = 0;
  const worker = async () => {
    while (index < urls.length) {
      const url = urls[index++];
      if (bytes > 500 * 1024 * 1024) {
        failed.push(url);
        continue;
      }
      const got = await download(url, opts);
      if (!got) {
        failed.push(url);
        continue;
      }
      const file = `${sha1(url).slice(0, 16)}.${EXT[got.type] || "img"}`;
      writeFileSync(path.join(assetsDir, file), got.body);
      bytes += got.body.length;
      done.set(url, file);
      files.push({ url, file, bytes: got.body.length, type: got.type });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  for (const [url, refs] of targets) {
    const file = done.get(url);
    if (!file) continue;
    for (const { el, attr } of refs) {
      el.setAttribute(attr, `assets/${file}`);
      if (attr === "src") el.setAttribute("data-acorn-src", url);
    }
  }
  const attachments = await localizeAttachments(root, opts);
  bytes += attachments.reduce((n, a) => n + a.bytes, 0);
  const lead = opts.leadImage ? done.get(opts.leadImage) || null : files[0]?.file || null;
  return { html: root.innerHTML, files, attachments, failed, leadFile: lead ? `assets/${lead}` : null, bytes };
}
