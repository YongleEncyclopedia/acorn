/**
 * Translation helpers shared by the web reader and the server: which parts of an article are
 * translatable blocks, and whether a text is already in the target language. Works on any DOM
 * (the browser's, or linkedom on the server).
 */

/** Marks elements Acorn inserted (translations); highlights and block detection skip them. */
export const TR_ATTR = "data-acorn-tr";

const LEAF = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,summary,div,section";
// Anything block-level inside an element means the element is a container, not a leaf.
const BLOCK_INSIDE = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,summary,div,section,ul,ol,dl,table,pre,figure,article,header,footer,aside,nav,hr";

export const sourceKey = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Text of a node without any translations Acorn inserted into it. */
export function blockText(node: Node): string {
  let s = "";
  for (const c of node.childNodes) {
    if (c.nodeType === 3) s += c.nodeValue || "";
    else if (c.nodeType === 1 && !(c as Element).hasAttribute(TR_ATTR)) s += blockText(c);
  }
  return s;
}

/** Leaf blocks whose text needs translating into `lang`, in document order. */
export function translatableBlocks(root: Element, lang: string): Element[] {
  const out: Element[] = [];
  for (const el of root.querySelectorAll(LEAF)) {
    if (el.closest(`pre, code, [${TR_ATTR}]`) || el.querySelector(BLOCK_INSIDE)) continue;
    if (needsTranslation(blockText(el), lang)) out.push(el);
  }
  return out;
}

interface ScriptCounts {
  letters: number;
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  cyrillic: number;
}

function scripts(text: string): ScriptCounts {
  const n = (re: RegExp) => (text.match(re) || []).length;
  return {
    letters: n(/\p{L}/gu),
    han: n(/\p{Script=Han}/gu),
    kana: n(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hangul: n(/\p{Script=Hangul}/gu),
    latin: n(/\p{Script=Latin}/gu),
    cyrillic: n(/\p{Script=Cyrillic}/gu),
  };
}

/** Is `text` written in (roughly) the script of `lang`? */
export function isInLanguage(text: string, lang: string): boolean {
  const s = scripts(text);
  if (!s.letters) return true;
  const base = lang.toLowerCase().split("-")[0];
  if (base === "zh") return s.han / s.letters >= 0.3 && s.kana / s.letters < 0.05;
  if (base === "ja") return s.kana / s.letters >= 0.05;
  if (base === "ko") return s.hangul / s.letters >= 0.3;
  if (base === "ru" || base === "uk") return s.cyrillic / s.letters >= 0.5;
  // Latin-script targets: anything mostly Latin counts as "already readable".
  return s.latin / s.letters >= 0.7;
}

export function needsTranslation(text: string, lang: string): boolean {
  const t = sourceKey(text);
  return (t.match(/\p{L}/gu) || []).length >= 2 && !/^https?:\/\/\S+$/.test(t) && !isInLanguage(t, lang);
}

/** Should a whole article be translated automatically? Looks at a sample of its text. */
export function isForeign(text: string, lang: string): boolean {
  const sample = sourceKey(text).slice(0, 4000);
  return (sample.match(/\p{L}/gu) || []).length >= 80 && !isInLanguage(sample, lang);
}

export const TARGET_LANGS: { code: string; label: string; name: string }[] = [
  { code: "zh-CN", label: "简体中文", name: "Simplified Chinese" },
  { code: "zh-TW", label: "繁體中文", name: "Traditional Chinese" },
  { code: "en", label: "English", name: "English" },
  { code: "ja", label: "日本語", name: "Japanese" },
];

export const langName = (code: string): string => TARGET_LANGS.find((l) => l.code === code)?.name || code;
