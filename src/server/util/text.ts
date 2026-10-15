import { createHash, randomBytes } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha1(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Very small HTML → text for excerpts and search indexing (not for rendering). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|section|article|figure)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITY[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v 　]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function excerpt(text: string, max = 220): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max).replace(/[\s,，、。.;；:：!！?？]+\S*$/, "") + "…";
}

/** Word count that treats each CJK character as one word. */
export function countWords(text: string): number {
  const cjk = text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g)?.length ?? 0;
  const latin = text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, " ").match(/[A-Za-z0-9À-ɏ]+/g)?.length ?? 0;
  return cjk + latin;
}

/** Character 4-gram Jaccard similarity, robust to small edits; used for change detection. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, "");
    const set = new Set<string>();
    for (let i = 0; i + 4 <= t.length; i += 1) set.add(t.slice(i, i + 4));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function slugify(title: string, max = 40): string {
  const s = title
    .replace(/[\\/:*?"<>|#%{}^~[\]`'’“”\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return s || "untitled";
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
