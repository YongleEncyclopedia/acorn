/**
 * What the reader needs to know about an article's text before setting it: which paragraphs are Latin-script
 * (they are not justified or indented the Chinese way) and where its headings are (the outline).
 * Works on any DOM, the browser's or linkedom's, like translate.ts next to it.
 */
import { TR_ATTR } from "./translate.ts";

export type Script = "cjk" | "latin";

/** Marks a paragraph set as Western text: ragged right, no two-character indent. */
export const LATIN_ATTR = "data-latin";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LETTER = /\p{L}/gu;

/**
 * The writing system a piece of text is set in. Chinese full of English terms is still Chinese: one character
 * in six being CJK is enough, because every CJK character is a place where a justified line can stretch.
 */
export function dominantScript(text: string): Script {
  const sample = text.length > 600 ? text.slice(0, 600) : text;
  const letters = (sample.match(LETTER) || []).length;
  if (!letters) return "cjk";
  const cjk = (sample.match(CJK) || []).length;
  return cjk * 6 >= letters ? "cjk" : "latin";
}

/**
 * Tag the Latin-script paragraphs of an article and report what the article as a whole is written in.
 * Justifying Western text the way Chinese is justified pulls its letters apart; it reads best ragged-right.
 */
export function markScripts(root: Element): Script {
  for (const p of root.querySelectorAll("p")) {
    if (p.closest(`[${TR_ATTR}]`)) continue;
    const text = p.textContent || "";
    if (text.trim().length >= 2 && dominantScript(text) === "latin") p.setAttribute(LATIN_ATTR, "");
    else p.removeAttribute(LATIN_ATTR);
  }
  return dominantScript((root.textContent || "").replace(/\s+/g, " ").trim());
}

export interface Heading<E = Element> {
  el: E;
  /** 0 for the article's top-level sections, 1 and 2 for what is nested under them. */
  depth: number;
  text: string;
}

/**
 * The article's headings, for the outline. Levels are counted from the highest one the article actually uses
 * (many sites start at h3), and anything deeper than three levels is folded into the third.
 */
export function collectOutline<E extends Element = Element>(root: E): Heading<E>[] {
  const found: { el: E; level: number; text: string }[] = [];
  for (const el of root.querySelectorAll("h1, h2, h3, h4")) {
    if (el.closest(`[${TR_ATTR}], blockquote, figure, table, li`)) continue;
    const text = headingText(el).replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 120) continue;
    found.push({ el: el as E, level: Number(el.tagName[1]), text });
  }
  if (!found.length) return [];
  const top = Math.min(...found.map((h) => h.level));
  return found.map((h) => ({ el: h.el, depth: Math.min(h.level - top, 2), text: h.text }));
}

/** A heading's own words, without the translation Acorn may have placed inside it. */
function headingText(node: Node): string {
  let s = "";
  for (const c of node.childNodes) {
    if (c.nodeType === 3) s += c.nodeValue || "";
    else if (c.nodeType === 1 && !(c as Element).hasAttribute(TR_ATTR)) s += headingText(c);
  }
  return s;
}
