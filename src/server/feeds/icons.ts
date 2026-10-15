import { writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import type { App } from "../app.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { absolutize, originOf } from "../util/url.ts";

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function iconFile(app: App, feedId: number): string | null {
  for (const f of readdirSync(app.cfg.iconsDir)) if (f.startsWith(`${feedId}.`)) return path.join(app.cfg.iconsDir, f);
  return null;
}

async function tryIcon(url: string, userAgent: string): Promise<{ body: Buffer; ext: string } | null> {
  try {
    const res = await httpGet(url, { userAgent, maxBytes: 300_000, timeoutMs: 12_000, accept: "image/*" });
    const type = res.contentType.split(";")[0].trim().toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!res.ok || !ext || res.body.length < 60) return null;
    return { body: res.body, ext };
  } catch {
    return null;
  }
}

async function saveIcon(app: App, feedId: number, url: string): Promise<boolean> {
  const icon = await tryIcon(url, app.cfg.pageUserAgent);
  if (!icon) return false;
  const old = iconFile(app, feedId);
  if (old && existsSync(old)) unlinkSync(old);
  writeFileSync(path.join(app.cfg.iconsDir, `${feedId}.${icon.ext}`), icon.body);
  app.feeds.update(feedId, { hasIcon: true });
  return true;
}

/** Find and store a site icon for a feed (`preferred` first, then link rel=icon, apple-touch-icon, /favicon.ico). */
export async function fetchIcon(app: App, feedId: number, siteUrl: string, articleUrl: string | null, preferred: string | null = null): Promise<void> {
  if (preferred && (await saveIcon(app, feedId, preferred))) return;
  const candidates: string[] = [];
  const pages = [siteUrl, articleUrl ? originOf(articleUrl) : null].filter((x): x is string => !!x);
  for (const page of pages) {
    try {
      const res = await httpGet(page, { userAgent: app.cfg.pageUserAgent, maxBytes: 2_000_000, timeoutMs: 15_000, accept: "text/html" });
      if (res.ok) {
        const { document } = parseHTML(decodeBody(res.body, res.contentType));
        const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')];
        links.sort((a, b) => (/apple/.test(b.getAttribute("rel") || "") ? 1 : 0) - (/apple/.test(a.getAttribute("rel") || "") ? 1 : 0));
        for (const l of links) {
          const u = absolutize(l.getAttribute("href"), res.url);
          if (u && !u.startsWith("data:")) candidates.push(u);
        }
      }
    } catch {
      /* ignore */
    }
    const origin = originOf(page);
    if (origin) candidates.push(`${origin}/favicon.ico`, `${origin}/apple-touch-icon.png`);
  }
  for (const url of new Set(candidates)) if (await saveIcon(app, feedId, url)) return;
}
