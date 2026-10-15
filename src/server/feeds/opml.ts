import { XMLParser } from "fast-xml-parser";
import type { App } from "../app.ts";
import type { FeedConfig, FeedKind } from "../../shared/types.ts";
import { parseRsshubInput } from "./rsshub.ts";
import { rsshubBase, resolveSourceUrl } from "./source.ts";
import { queueRefresh } from "./refresh.ts";

interface Outline {
  text?: string;
  title?: string;
  type?: string;
  xmlUrl?: string;
  htmlUrl?: string;
  acornKind?: string;
  acornUrl?: string;
  acornConfig?: string;
  outline?: Outline[];
}

/** Import an OPML file (folders become Acorn folders). Returns counts. */
export function importOpml(app: App, xml: string): { added: number; skipped: number; folders: number } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name) => name === "outline", processEntities: true, htmlEntities: true });
  const doc = parser.parse(xml) as { opml?: { body?: { outline?: Outline[] } } };
  const top = doc.opml?.body?.outline || [];
  let added = 0;
  let skipped = 0;
  let folders = 0;
  const add = (o: Outline, folderId: number | null) => {
    let kind: FeedKind = (o.acornKind as FeedKind) || "feed";
    let url = o.acornUrl || o.xmlUrl || "";
    if (!url) return;
    let config: FeedConfig = {};
    try {
      config = o.acornConfig ? JSON.parse(o.acornConfig) : {};
    } catch {
      config = {};
    }
    if (!o.acornKind) {
      const route = parseRsshubInput(url, [rsshubBase(app)]);
      if (route) {
        kind = "rsshub";
        url = route;
      }
    }
    if (app.feeds.find(kind, url)) {
      skipped += 1;
      return;
    }
    const feed = app.feeds.create({ kind, url, title: o.title || o.text || "", siteUrl: o.htmlUrl || null, folderId, config });
    queueRefresh(app, feed.id, -1);
    added += 1;
  };
  const walk = (list: Outline[], folderId: number | null) => {
    for (const o of list) {
      if (o.outline?.length && !o.xmlUrl && !o.acornUrl) {
        const name = (o.title || o.text || "未命名").trim();
        const existed = !!app.feeds.folderByName(name);
        const f = app.feeds.createFolder(name);
        if (!existed) folders += 1;
        walk(o.outline, f.id);
      } else add(o, folderId);
    }
  };
  walk(top, null);
  return { added, skipped, folders };
}

function attr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Export all subscriptions. RSSHub routes are exported as full URLs; Acorn-only sources keep their config. */
export function exportOpml(app: App): string {
  const feeds = app.feeds.list();
  const folders = app.feeds.folders();
  const line = (f: (typeof feeds)[number], indent: string) => {
    const xmlUrl = f.kind === "plugin" ? `plugin:${f.url}` : resolveSourceUrl(app, f.kind, f.url).replace(/([?&])key=[^&]*/, "$1").replace(/[?&]$/, "");
    const extra = f.kind === "feed" ? "" : ` acornKind="${f.kind}" acornUrl="${attr(f.url)}" acornConfig="${attr(JSON.stringify(f.config))}"`;
    return `${indent}<outline type="rss" text="${attr(f.title)}" title="${attr(f.title)}" xmlUrl="${attr(xmlUrl)}"${f.siteUrl ? ` htmlUrl="${attr(f.siteUrl)}"` : ""}${extra}/>`;
  };
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<opml version="2.0">`, `  <head><title>Acorn 松果 订阅</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>`, `  <body>`];
  for (const folder of folders) {
    const inFolder = feeds.filter((f) => f.folderId === folder.id);
    if (!inFolder.length) continue;
    out.push(`    <outline text="${attr(folder.name)}" title="${attr(folder.name)}">`);
    for (const f of inFolder) out.push(line(f, "      "));
    out.push(`    </outline>`);
  }
  for (const f of feeds.filter((f) => !f.folderId)) out.push(line(f, "    "));
  out.push(`  </body>`, `</opml>`, "");
  return out.join("\n");
}
