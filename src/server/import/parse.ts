/**
 * Read the export files of other tools into a list of links: browser bookmarks (Netscape HTML, also written by
 * Pocket, Raindrop, Pinboard…), CSV from Pocket / Instapaper / Raindrop / Readwise Reader or anything with a URL
 * column, JSON (Omnivore and other dumps), or plain text with URLs in it. The format is sniffed from the content.
 */
import { canonicalUrl, isHttpUrl } from "../util/url.ts";
import { htmlToText } from "../util/text.ts";

export type ImportFormat = "bookmarks" | "pocket" | "instapaper" | "raindrop" | "readwise" | "csv" | "json" | "text";

export interface ImportLink {
  url: string;
  title: string | null;
  tags: string[];
  note: string | null;
  savedAt: number | null;
}

export interface ParsedImport {
  format: ImportFormat;
  links: ImportLink[];
  /** Links left out: bookmarklets, browser pages, other non-web addresses, duplicates. */
  skipped: number;
}

export const FORMAT_LABEL: Record<ImportFormat, string> = {
  bookmarks: "浏览器书签",
  pocket: "Pocket",
  instapaper: "Instapaper",
  raindrop: "Raindrop",
  readwise: "Readwise Reader",
  csv: "CSV 表格",
  json: "JSON",
  text: "网址列表",
};

export const MAX_LINKS = 20_000;

// Folders every browser has; they say where a bookmark sits, not what it is about.
const ROOT_FOLDERS = new Set(
  [
    "bookmarks bar", "bookmarks toolbar", "bookmarks menu", "bookmarks", "other bookmarks", "mobile bookmarks", "favorites bar",
    "favorites", "other favorites", "menu", "toolbar", "unfiled", "书签栏", "书签工具栏", "书签菜单", "其他书签", "移动设备书签",
    "收藏夹栏", "收藏夹", "其他收藏夹", "unread", "archive", "read archive", "starred", "liked", "unsorted", "未分类",
  ].map((s) => s.toLowerCase()),
);

export function parseImport(raw: string): ParsedImport {
  const text = raw.replace(/^﻿/, "");
  const head = text.slice(0, 4000);
  let format: ImportFormat;
  let links: ImportLink[];
  if (/<!DOCTYPE NETSCAPE-Bookmark-file/i.test(head) || (/<a\s[^>]*href\s*=/i.test(text) && /<(dl|ul|h1|h3)\b/i.test(head))) {
    format = /<title>\s*Pocket Export/i.test(head) ? "pocket" : "bookmarks";
    links = parseBookmarksHtml(text);
  } else if (/^\s*[[{]/.test(head) && isJson(text)) {
    format = "json";
    links = parseJson(JSON.parse(text));
  } else {
    const rows = parseCsv(text);
    const header = rows[0]?.map((h) => h.trim().toLowerCase()) || [];
    if (rows.length > 1 && header.some((h) => URL_COLUMNS.includes(h))) {
      format = header.includes("time_added")
        ? "pocket"
        : header.includes("selection") && header.includes("folder")
          ? "instapaper"
          : header.includes("cover") && header.includes("folder")
            ? "raindrop"
            : header.includes("document tags") || header.includes("saved date")
              ? "readwise"
              : "csv";
      links = csvLinks(header, rows.slice(1));
    } else {
      format = "text";
      links = [...text.matchAll(/https?:\/\/[^\s<>"'`{}|\\^，。、；：！？（）【】《》「」]+/g)].map((m) => ({
        url: m[0].replace(/[.,;:!?)\]}>'"]+$/, ""),
        title: null,
        tags: [],
        note: null,
        savedAt: null,
      }));
    }
  }
  return clean(format, links);
}

/** Keep web links only, one per canonical URL (merging tags, keeping the earliest save time). */
function clean(format: ImportFormat, links: ImportLink[]): ParsedImport {
  const byUrl = new Map<string, ImportLink>();
  let skipped = 0;
  for (const l of links) {
    const url = l.url.trim();
    if (!isHttpUrl(url)) {
      skipped++;
      continue;
    }
    const key = canonicalUrl(url);
    const seen = byUrl.get(key);
    if (seen) {
      skipped++;
      seen.tags = [...new Set([...seen.tags, ...l.tags])];
      if (l.savedAt && (!seen.savedAt || l.savedAt < seen.savedAt)) seen.savedAt = l.savedAt;
      seen.title ||= l.title;
      seen.note ||= l.note;
      continue;
    }
    if (byUrl.size >= MAX_LINKS) {
      skipped++;
      continue;
    }
    byUrl.set(key, { ...l, url, title: l.title?.trim() || null, tags: [...new Set(l.tags.map((t) => t.trim()).filter(Boolean))] });
  }
  return { format, links: [...byUrl.values()], skipped };
}

function time(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let t: number;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    t = n > 1e12 ? n : n * 1000; // seconds (Pocket, Instapaper, bookmarks) or milliseconds
    if (n > 1e15) t = n / 1000; // Firefox/Chrome microseconds
  } else {
    t = Date.parse(String(v));
  }
  // between the first browsers and tomorrow
  return Number.isFinite(t) && t > Date.UTC(1993, 0, 1) && t < Date.now() + 86_400_000 ? Math.round(t) : null;
}

function splitTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => (typeof t === "string" ? t : (t as { name?: string })?.name || "")).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      return splitTags(JSON.parse(s));
    } catch {
      // a Python-style list, as in Readwise exports: ['a', 'b']
      return splitTags(s.replace(/[[\]'"]/g, ""));
    }
  }
  return s.split(s.includes("|") ? "|" : /[,，;；]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
}

const folderTags = (path: string[]) => path.filter((f) => f && !ROOT_FOLDERS.has(f.toLowerCase()));

// ---- bookmarks HTML ----

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Netscape bookmark files nest folders as <H3>name</H3><DL>…</DL>; tags and dates are attributes of the links. */
export function parseBookmarksHtml(html: string): ImportLink[] {
  const out: ImportLink[] = [];
  const folders: (string | null)[] = [];
  let pendingFolder: string | null = null;
  const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<dl\b[^>]*>|<\/dl\s*>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dd>([^<]*)/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (tag === "<h3") pendingFolder = htmlToText(m[1]);
    else if (tag === "<dl") {
      folders.push(pendingFolder);
      pendingFolder = null;
    } else if (tag === "</d") folders.pop();
    else if (tag === "<dd") {
      const last = out[out.length - 1];
      const note = htmlToText(m[4]);
      if (last && note && !last.note) last.note = note;
    } else {
      const attrs = m[2] || "";
      const href = htmlToText(attr(attrs, "href") || "");
      if (!href) continue;
      out.push({
        url: href,
        title: htmlToText(m[3]) || null,
        tags: [...folderTags(folders.filter((f): f is string => !!f)), ...splitTags(attr(attrs, "tags"))],
        note: null,
        savedAt: time(attr(attrs, "add_date") ?? attr(attrs, "time_added")),
      });
    }
  }
  return out;
}

// ---- CSV ----

const URL_COLUMNS = ["url", "link", "href", "address", "original url", "网址", "链接"];
const pick = (header: string[], names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;

function csvLinks(header: string[], rows: string[][]): ImportLink[] {
  const col = {
    url: pick(header, URL_COLUMNS),
    title: pick(header, ["title", "name", "标题"]),
    tags: pick(header, ["tags", "labels", "document tags", "标签"]),
    folder: pick(header, ["folder", "collection", "文件夹", "收藏夹"]),
    time: pick(header, ["time_added", "timestamp", "created", "created_at", "saved date", "date added", "added", "saved_at", "date", "时间"]),
    notes: ["note", "notes", "selection", "highlights", "备注"].map((n) => header.indexOf(n)).filter((i) => i >= 0),
  };
  return rows
    .filter((r) => r[col.url]?.trim())
    .map((r) => ({
      url: r[col.url].trim(),
      title: col.title >= 0 ? r[col.title] || null : null,
      tags: [...(col.folder >= 0 ? folderTags((r[col.folder] || "").split("/").map((s) => s.trim())) : []), ...(col.tags >= 0 ? splitTags(r[col.tags]) : [])],
      note: col.notes.map((i) => r[i]?.trim()).filter(Boolean).join("\n\n") || null,
      savedAt: col.time >= 0 ? time(r[col.time]) : null,
    }));
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes); tab-separated files work too. */
export function parseCsv(text: string): string[][] {
  const nl = text.indexOf("\n");
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const sep = (firstLine.match(/\t/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

// ---- JSON ----

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const first = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");

function parseJson(data: unknown): ImportLink[] {
  const list = findList(data);
  return list.flatMap((o) => {
    const url = first(o, ["url", "link", "href", "originalUrl", "original_url", "given_url", "resolved_url"]);
    if (typeof url !== "string") return [];
    return [
      {
        url,
        title: String(first(o, ["title", "name", "given_title", "resolved_title"]) ?? "") || null,
        tags: [...splitTags(first(o, ["tags", "labels"])), ...folderTags([String(first(o, ["folder", "collection"]) ?? "")])],
        note: String(first(o, ["note", "notes", "annotation"]) ?? "") || null,
        savedAt: time(first(o, ["savedAt", "saved_at", "time_added", "created", "createdAt", "created_at", "dateAdded", "date_added", "date"])),
      },
    ];
  });
}

/** The array of link objects: the root itself, or the first array of objects found inside it. */
function findList(data: unknown, depth = 0): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    const objs = data.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    if (objs.some((o) => typeof first(o, ["url", "link", "href", "originalUrl", "given_url"]) === "string")) return objs;
    return depth < 3 ? objs.flatMap((o) => findList(Object.values(o), depth + 1)) : [];
  }
  if (data && typeof data === "object" && depth < 3) {
    // Pocket's old JSON API dump: { list: { "<id>": {…}, … } }
    const values = Object.values(data as Record<string, unknown>);
    for (const v of values) {
      const found = findList(v, depth + 1);
      if (found.length) return found;
    }
    return findList(values, depth + 1);
  }
  return [];
}
