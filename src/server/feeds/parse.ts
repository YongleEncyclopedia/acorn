import { parseFeed } from "feedsmith";
import { absolutize } from "../util/url.ts";
import { parseLooseDate } from "../util/dates.ts";
import { sha1 } from "../util/text.ts";

/** A feed item normalized from RSS / Atom / RDF / JSON Feed, before sanitization. */
export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  contentHtml: string | null;
  summary: string | null;
  image: string | null;
  publishedAt: number | null;
}

export interface ParsedFeed {
  format: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  image: string | null;
  items: ParsedItem[];
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Text from feedsmith values that may be a string, {value}, or an array of either. */
function txt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object" && "value" in (v as Any)) return txt((v as Any).value);
  return "";
}

function firstImg(html: string | null): string | null {
  return html?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null;
}

function people(v: unknown): string | null {
  if (!Array.isArray(v) || !v.length) return null;
  const names = v.map((p) => (typeof p === "string" ? p : (p as Any)?.name)).filter(Boolean);
  return names.length ? names.join(", ") : null;
}

function atomLink(links: unknown, rel = "alternate"): string | null {
  if (!Array.isArray(links)) return null;
  const pick = links.find((l: Any) => (l.rel || "alternate") === rel && (!l.type || /html/.test(l.type))) || links.find((l: Any) => !l.rel || l.rel === rel);
  return pick?.href ?? null;
}

function mediaImage(item: Any): string | null {
  const m = item.media;
  if (!m) return null;
  const thumbs = m.thumbnails || m.groups?.flatMap((g: Any) => g.thumbnails || []) || [];
  if (thumbs[0]?.url) return thumbs[0].url;
  const contents: Any[] = [...(m.contents || []), ...(m.groups?.flatMap((g: Any) => g.contents || []) || [])];
  const img = contents.find((c) => c.medium === "image" || /^image\//.test(c.type || "") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(c.url || ""));
  return img?.url ?? null;
}

function guidFor(parts: { id?: string | null; url?: string | null; title: string; date: number | null }): string {
  if (parts.id) return parts.id.slice(0, 500);
  if (parts.url) return parts.url.slice(0, 500);
  return `h:${sha1(`${parts.title}|${parts.date ?? ""}`)}`;
}

export class NotAFeedError extends Error {
  constructor(message = "不是有效的 RSS / Atom / JSON Feed") {
    super(message);
  }
}

export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes("<!doctype html") || /<html[\s>]/.test(head) || (head.includes("<head") && head.includes("<body"));
}

export function parseFeedText(text: string, feedUrl: string): ParsedFeed {
  const trimmed = text.replace(/^﻿/, "").trim();
  let parsed: { format: string; feed: Any };
  try {
    parsed = parseFeed(trimmed) as unknown as { format: string; feed: Any };
  } catch (err) {
    if (looksLikeHtml(trimmed)) throw new NotAFeedError("这是一个网页，不是订阅源");
    throw new NotAFeedError(`无法解析订阅源：${(err as Error).message}`);
  }
  const { format, feed } = parsed;

  if (format === "json") {
    const base = feed.home_page_url || feedUrl;
    const items: ParsedItem[] = (feed.items || []).map((it: Any) => {
      const url = absolutize(it.url || it.external_url, base);
      const contentHtml = it.content_html || (it.content_text ? `<p>${String(it.content_text).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;")).replace(/\n{2,}/g, "</p><p>")}</p>` : null);
      const publishedAt = parseLooseDate(it.date_published || it.date_modified);
      const title = txt(it.title) || (it.content_text ? String(it.content_text).slice(0, 80) : "");
      return {
        guid: guidFor({ id: it.id != null ? String(it.id) : null, url, title, date: publishedAt }),
        url,
        title,
        author: people(it.authors) || it.author?.name || null,
        contentHtml,
        summary: it.summary || null,
        image: absolutize(it.image || it.banner_image, base) || firstImg(contentHtml),
        publishedAt,
      };
    });
    return { format, title: txt(feed.title), siteUrl: feed.home_page_url || null, description: feed.description || null, image: feed.icon || feed.favicon || null, items };
  }

  if (format === "atom") {
    const siteUrl = atomLink(feed.links) || null;
    const base = siteUrl || feedUrl;
    const items: ParsedItem[] = (feed.entries || []).map((e: Any) => {
      const url = absolutize(atomLink(e.links), e.content?.xml?.base || base);
      const contentHtml = txt(e.content) || null;
      const summaryHtml = txt(e.summary) || null;
      const publishedAt = parseLooseDate(e.published || e.updated);
      const title = txt(e.title);
      return {
        guid: guidFor({ id: e.id, url, title, date: publishedAt }),
        url,
        title,
        author: people(e.authors) || people(feed.authors),
        contentHtml: contentHtml || summaryHtml,
        summary: contentHtml && summaryHtml && summaryHtml !== contentHtml ? summaryHtml : null,
        image: mediaImage(e) || firstImg(contentHtml || summaryHtml),
        publishedAt,
      };
    });
    return { format, title: txt(feed.title), siteUrl, description: txt(feed.subtitle) || null, image: feed.icon || feed.logo || null, items };
  }

  // rss / rdf
  const siteUrl = feed.link || atomLink(feed.atom?.links) || null;
  const base = siteUrl || feedUrl;
  const items: ParsedItem[] = (feed.items || []).map((it: Any) => {
    const url = absolutize(it.link || (it.guid?.isPermaLink !== false ? txt(it.guid) : null) || atomLink(it.atom?.links), base);
    const encoded = it.content?.encoded || null;
    const description = it.description || null;
    const contentHtml = encoded || description;
    const publishedAt = parseLooseDate(it.pubDate || it.dc?.dates?.[0] || it.dc?.date || it.atom?.published || it.atom?.updated);
    const title = txt(it.title) || (description ? description.replace(/<[^>]+>/g, "").slice(0, 80) : "");
    const enclosureImg = (it.enclosures || []).find((en: Any) => /^image\//.test(en.type || ""))?.url;
    return {
      guid: guidFor({ id: txt(it.guid) || null, url, title, date: publishedAt }),
      url,
      title,
      author: people(it.authors) || it.dc?.creators?.join(", ") || it.itunes?.author || null,
      contentHtml,
      summary: encoded && description && description !== encoded ? description : null,
      image: absolutize(mediaImage(it) || enclosureImg || it.itunes?.image || firstImg(contentHtml), base),
      publishedAt,
    };
  });
  return { format, title: txt(feed.title), siteUrl, description: feed.description || null, image: feed.image?.url || null, items };
}
