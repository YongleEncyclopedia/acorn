import { parseHTML } from "linkedom";
import type { HtmlRule } from "../../shared/types.ts";
import type { ParsedItem } from "./parse.ts";
import { absolutize } from "../util/url.ts";
import { DATE_PATTERN, isDateText, parseLooseDate } from "../util/dates.ts";
import { sha1 } from "../util/text.ts";

/** "sel@attr" → [sel, attr]; "@attr" → ["", attr] (attribute on the item itself). */
function splitSel(sel: string): [string, string | null] {
  const i = sel.lastIndexOf("@");
  if (i <= 0 && !sel.startsWith("@")) return [sel.trim(), null];
  if (/\[[^\]]*@[^\]]*\]/.test(sel)) return [sel.trim(), null];
  return [sel.slice(0, i).trim(), sel.slice(i + 1).trim() || null];
}

function pick(root: Element, sel: string | undefined, defaultAttr: string | null = null): { el: Element | null; value: string } {
  if (!sel) return { el: null, value: "" };
  const [css, attr] = splitSel(sel);
  const el = css ? root.querySelector(css) : root;
  if (!el) return { el: null, value: "" };
  const a = attr || defaultAttr;
  const value = a ? el.getAttribute(a) || "" : (el.textContent || "").replace(/\s+/g, " ").trim();
  return { el, value };
}

const DATE_CLASS = /(^|[\s_-])(date|time|sj|rq|riqi|shijian|pubtime|pubdate|day|fbsj)([\s_-]|$)/i;

/** The element inside an item that holds its date: a date-ish class name first, then any short date-only text. */
export function findDateElement(item: Element): Element | null {
  for (const el of item.querySelectorAll("*")) {
    const sig = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
    if (DATE_CLASS.test(sig) && isDateText(el.textContent || "")) return el;
  }
  for (const el of item.querySelectorAll("span, em, i, td, div, p, time, font, b, small")) {
    if (el.querySelector("a")) continue;
    if (isDateText(el.textContent || "")) return el;
  }
  return null;
}

function bestTitle(a: Element | null, fallbackText: string): string {
  const text = (a?.textContent || fallbackText).replace(/\s+/g, " ").trim();
  const attr = a?.getAttribute("title")?.trim() || "";
  // School sites often truncate titles in the text and keep the full one in title="".
  if (attr && (attr.length > text.length || /(\.\.\.|…)$/.test(text))) return attr;
  return text;
}

/** Apply a selector rule to an HTML list page. */
export function scrapeList(html: string, pageUrl: string, rule: HtmlRule): ParsedItem[] {
  const { document } = parseHTML(html);
  const base = absolutize(document.querySelector("base[href]")?.getAttribute("href"), pageUrl) || pageUrl;
  const out: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const item of document.querySelectorAll(rule.item)) {
    const titlePick = rule.title ? pick(item, rule.title) : { el: item.querySelector("a[href]"), value: "" };
    const titleEl = titlePick.el;
    const anchor = titleEl?.closest?.("a[href]") || (titleEl?.matches?.("a[href]") ? titleEl : null) || item.querySelector("a[href]");
    const title = rule.title && !titleEl?.matches?.("a") ? titlePick.value : bestTitle(anchor, titlePick.value);
    const linkRaw = rule.link ? pick(item, rule.link, "href").value : anchor?.getAttribute("href") || "";
    const url = absolutize(linkRaw, base);
    if (!title || !url) continue;
    const dateText = rule.date
      ? pick(item, rule.date).value
      : (findDateElement(item)?.textContent || "").replace(/\s+/g, " ").trim() || (item.textContent || "").match(DATE_PATTERN)?.[0] || "";
    const publishedAt = parseLooseDate(dateText);
    const summary = rule.summary ? pick(item, rule.summary).value || null : null;
    const image = rule.image ? absolutize(pick(item, rule.image, "src").value, base) : null;
    const guid = url || `h:${sha1(title)}`;
    if (seen.has(guid)) continue;
    seen.add(guid);
    out.push({ guid, url, title, author: null, contentHtml: summary ? `<p>${summary}</p>` : null, summary, image, publishedAt });
  }
  return out;
}

function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, "\\$1");
}

function selectorFor(el: Element, depth = 0): string {
  const id = el.getAttribute("id");
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${cssEscape(id)}`;
  const tag = el.tagName.toLowerCase();
  const classes = (el.getAttribute("class") || "")
    .split(/\s+/)
    .filter((c) => c && /^[A-Za-z_][\w-]*$/.test(c) && !/^(active|on|cur|current|clearfix|fl|fr|left|right|hover)$/i.test(c))
    .slice(0, 2);
  const self = tag + classes.map((c) => `.${cssEscape(c)}`).join("");
  if (depth >= 3 || !el.parentElement || el.parentElement.tagName.toLowerCase() === "body") return self;
  if (classes.length) return self;
  return `${selectorFor(el.parentElement, depth + 1)} > ${self}`;
}

const NAV_RE = /(^|[\s_-])(nav|menu|header|footer|foot|breadcrumb|crumb|sidebar|links|friend|copyright|tabs?)([\s_-]|$)/i;

function inChrome(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "nav" || tag === "header" || tag === "footer") return true;
    if (NAV_RE.test(`${cur.getAttribute("class") || ""} ${cur.getAttribute("id") || ""}`)) return true;
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Guess the list of articles on a page (e.g. a department "通知公告" page): the container whose repeated children
 * most often contain a meaningful link and a date. Returns a rule, or null when nothing list-like is found.
 */
export function suggestRule(html: string, pageUrl: string): HtmlRule | null {
  const { document } = parseHTML(html);
  let best: { score: number; container: Element; tag: string; cls: string; n: number; dateSel: string | null } | null = null;
  for (const container of document.querySelectorAll("ul, ol, tbody, div, table, section, dl")) {
    const kids = [...container.children];
    if (kids.length < 4) continue;
    const groups = new Map<string, Element[]>();
    for (const k of kids) {
      const key = `${k.tagName}|${(k.getAttribute("class") || "").split(/\s+/)[0] || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(k);
    }
    for (const [key, els] of groups) {
      if (els.length < 4) continue;
      let withLink = 0;
      let withDate = 0;
      let textLen = 0;
      const dateTags = new Map<string, number>();
      for (const el of els) {
        const a = el.querySelector("a[href]") || (el.matches("a[href]") ? el : null);
        const t = bestTitle(a, "");
        if (a && [...t].length >= 6 && !/^javascript:/i.test(a.getAttribute("href") || "")) withLink += 1;
        const text = el.textContent || "";
        const dateEl = findDateElement(el);
        if (dateEl || DATE_PATTERN.test(text)) withDate += 1;
        if (dateEl) {
          const cls = (dateEl.getAttribute("class") || "").split(/\s+/)[0];
          const sel = dateEl.tagName.toLowerCase() + (cls && /^[A-Za-z_][\w-]*$/.test(cls) ? `.${cls}` : "");
          dateTags.set(sel, (dateTags.get(sel) || 0) + 1);
        }
        textLen += text.trim().length;
      }
      if (withLink < 4) continue;
      const avg = textLen / els.length;
      let score = withLink + withDate * 1.5 + Math.min(avg, 60) / 20;
      if (inChrome(container)) score *= 0.25;
      if (avg < 8) score *= 0.3;
      if (!best || score > best.score) {
        const [tag, cls] = key.split("|");
        const topDate = [...dateTags.entries()].sort((a, b) => b[1] - a[1])[0];
        best = { score, container, tag: tag.toLowerCase(), cls, n: els.length, dateSel: topDate && topDate[1] >= els.length * 0.6 ? topDate[0] : null };
      }
    }
  }
  if (!best) return null;
  const item = `${selectorFor(best.container)} > ${best.tag}${best.cls && /^[A-Za-z_][\w-]*$/.test(best.cls) ? `.${cssEscape(best.cls)}` : ""}`;
  const rule: HtmlRule = { item };
  if (best.dateSel) rule.date = best.dateSel;
  // Validate: the generated selector must still find the items.
  return scrapeList(html, pageUrl, rule).length >= 3 ? rule : null;
}
