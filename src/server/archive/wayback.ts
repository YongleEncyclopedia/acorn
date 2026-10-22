/**
 * Rescue a dead link from the Internet Archive: find the Wayback Machine capture closest to when the link was saved,
 * fetch it without the Wayback toolbar, point images at the archived copies and links back at the original web,
 * and archive that as a snapshot of the original URL (marked gone).
 */
import { parseHTML } from "linkedom";
import type { App } from "../app.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { capture, type CaptureResult } from "./capture.ts";
import { logger } from "../util/log.ts";

const log = logger("wayback");
const GAP_MS = 1500;

export interface WaybackCapture {
  timestamp: string;
  at: number;
  /** The capture without the Wayback toolbar ("if_" mode). */
  url: string;
}

// The Internet Archive throttles busy clients: one request at a time, with a gap.
let chain: Promise<unknown> = Promise.resolve();
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, GAP_MS)),
    () => new Promise((r) => setTimeout(r, GAP_MS)),
  );
  return run;
}

const stamp = (t: number) => new Date(t).toISOString().replace(/\D/g, "").slice(0, 14);
const stampTime = (ts: string) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10) || 0, +ts.slice(10, 12) || 0, +ts.slice(12, 14) || 0);

/** The successful HTML capture closest to `near` (default: the newest one). */
export async function findCapture(base: string, url: string, near?: number | null): Promise<WaybackCapture | null> {
  const q = new URLSearchParams({ url, output: "json", fl: "timestamp,original", limit: "1", sort: "closest", closest: stamp(near || Date.now()) });
  q.append("filter", "statuscode:200");
  q.append("filter", "mimetype:text/html");
  const res = await politely(() => httpGet(`${base}/cdx/search/cdx?${q}`, { accept: "application/json", timeoutMs: 30_000 }));
  if (res.status === 429) throw new Error("Internet Archive 暂时拒绝了请求（太频繁），稍后重试");
  if (!res.ok) throw new Error(`Internet Archive 返回 HTTP ${res.status}`);
  let rows: string[][];
  try {
    rows = JSON.parse(res.body.toString("utf8") || "[]");
  } catch {
    return null;
  }
  const hit = rows.find((r) => /^\d{14}$/.test(r[0]));
  return hit ? { timestamp: hit[0], at: stampTime(hit[0]), url: `${base}/web/${hit[0]}if_/${hit[1] || url}` } : null;
}

const WRAPPED = /^(?:https?:\/\/(?:web\.)?archive\.org)?\/web\/\d{1,14}(?:[a-z]{2}_)?\/(.+)$/i;

/** Make a Wayback page read like the original: original links, archived images, no playback scripts. */
export function unwrapWayback(html: string, original: string, ts: string, base: string): string {
  const cleaned = html
    .replace(/<script[^>]*archive\.org\/_static[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i, "")
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/i, "");
  const { document } = parseHTML(cleaned);
  const orig = (v: string | null): string | null => {
    if (!v || /^(data:|javascript:|#|mailto:)/i.test(v.trim())) return null;
    const m = v.trim().match(WRAPPED);
    try {
      return m ? new URL(m[1].replace(/^(https?:)\/(?!\/)/, "$1//")).toString() : new URL(v.trim(), original).toString();
    } catch {
      return null;
    }
  };
  const archived = (v: string | null) => {
    const o = orig(v);
    return o ? `${base}/web/${ts}im_/${o}` : null;
  };
  for (const a of document.querySelectorAll("a[href]")) {
    const o = orig(a.getAttribute("href"));
    if (o) a.setAttribute("href", o);
  }
  for (const el of document.querySelectorAll("img, source")) {
    for (const name of ["src", "data-src", "data-original", "data-lazy-src"]) {
      const v = archived(el.getAttribute(name));
      if (v) el.setAttribute(name, v);
    }
    for (const name of ["srcset", "data-srcset"]) {
      const v = el.getAttribute(name);
      if (v) el.setAttribute(name, v.split(",").map((part) => part.trim().replace(/^\S+/, (u) => archived(u) || u)).join(", "));
    }
  }
  return document.toString();
}

/** Archive `url` from its Internet Archive copy. Returns null when the Wayback Machine has none. */
export async function captureFromWayback(
  app: App,
  input: { url: string; near?: number | null; title?: string; tags?: string[]; quiet?: boolean },
): Promise<CaptureResult | null> {
  const base = app.cfg.waybackBase;
  const found = await findCapture(base, input.url, input.near);
  if (!found) return null;
  const res = await politely(() => httpGet(found.url, { accept: "text/html,*/*;q=0.8", timeoutMs: 60_000, maxBytes: 25 * 1024 * 1024 }));
  if (!res.ok) throw new Error(`Internet Archive 的副本打不开（HTTP ${res.status}）`);
  const html = unwrapWayback(decodeBody(res.body, res.contentType), input.url, found.timestamp, base);
  const date = new Date(found.at).toLocaleDateString("zh-CN");
  const result = await capture(app, {
    url: input.url,
    method: "wayback",
    html,
    finalUrl: input.url,
    title: input.title,
    tags: input.tags,
    quiet: input.quiet,
    force: true,
    warnings: [`原文已经失效，这份是 Internet Archive 在 ${date} 保存的副本`],
  });
  app.archives.setSourceStatus(result.archiveId, "gone", Date.now());
  log.info(`rescued ${input.url} from the Wayback Machine (${found.timestamp})`);
  return result;
}
