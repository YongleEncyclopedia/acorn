/**
 * Text-quote anchoring for highlights (W3C Web Annotation style): a highlight is stored as
 * { quote, prefix, suffix } and re-anchored on render by searching the article text, so it
 * survives re-rendering and works for both feed entries and archived snapshots.
 */
import type { Highlight } from "../../../src/shared/types.ts";
import { TR_ATTR } from "../../../src/shared/translate.ts";

interface TextMap {
  text: string;
  nodes: { node: Text; start: number; end: number }[];
}

const norm = (s: string) => s.replace(/\s+/g, " ");
const inTranslation = (n: Node) => {
  const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : n instanceof Element ? n : null;
  return !!el?.closest(`[${TR_ATTR}]`);
};

/** The article's own text nodes, in order (inserted translations are not part of the article). */
function textMap(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (inTranslation(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: TextMap["nodes"] = [];
  let text = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const value = t.data;
    nodes.push({ node: t, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, nodes };
}

/** Build a normalized string and an index map back into the raw text. */
function normalizeWithMap(raw: string): { s: string; map: number[] } {
  let s = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      s += " ";
      map.push(i);
      lastSpace = true;
    } else {
      s += ch;
      map.push(i);
      lastSpace = false;
    }
  }
  map.push(raw.length);
  return { s, map };
}

export function selectorFromRange(root: HTMLElement, range: Range): { quote: string; prefix: string; suffix: string } | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (inTranslation(range.startContainer) || inTranslation(range.endContainer)) return null;
  const { text, nodes } = textMap(root);
  // Character offset of a boundary point within the article's own text.
  const offset = (container: Node, off: number): number => {
    const hit = container.nodeType === Node.TEXT_NODE && nodes.find((n) => n.node === container);
    if (hit) return hit.start + off;
    const point = document.createRange();
    point.setStart(container, off);
    let total = 0;
    for (const n of nodes) {
      if (point.comparePoint(n.node, n.node.length) > 0) break;
      total = n.end;
    }
    return total;
  };
  const start = offset(range.startContainer, range.startOffset);
  const end = offset(range.endContainer, range.endOffset);
  if (end <= start) return null;
  const quote = norm(text.slice(start, end)).trim();
  if (!quote) return null;
  return {
    quote,
    prefix: norm(text.slice(Math.max(0, start - 40), start)).slice(-32),
    suffix: norm(text.slice(end, end + 40)).slice(0, 32),
  };
}

function anchor(full: { s: string; map: number[] }, h: Pick<Highlight, "quote" | "prefix" | "suffix">): [number, number] | null {
  const q = norm(h.quote).trim();
  if (!q) return null;
  let best: { at: number; score: number } | null = null;
  let from = 0;
  for (;;) {
    const at = full.s.indexOf(q, from);
    if (at < 0) break;
    let score = 0;
    const pre = full.s.slice(Math.max(0, at - h.prefix.length), at);
    const suf = full.s.slice(at + q.length, at + q.length + h.suffix.length);
    for (let i = 1; i <= Math.min(pre.length, h.prefix.length); i += 1) if (pre[pre.length - i] === h.prefix[h.prefix.length - i]) score += 1;
    for (let i = 0; i < Math.min(suf.length, h.suffix.length); i += 1) if (suf[i] === h.suffix[i]) score += 1;
    if (!best || score > best.score) best = { at, score };
    from = at + 1;
  }
  if (!best) return null;
  return [full.map[best.at], full.map[best.at + q.length - 1] + 1];
}

function wrap(root: HTMLElement, start: number, end: number, h: Highlight): HTMLElement | null {
  const { nodes } = textMap(root);
  let first: HTMLElement | null = null;
  for (const { node, start: ns, end: ne } of nodes) {
    if (ne <= start || ns >= end) continue;
    const a = Math.max(start, ns) - ns;
    const b = Math.min(end, ne) - ns;
    if (b <= a || !node.data.slice(a, b).trim()) continue;
    let target = node;
    if (a > 0) target = target.splitText(a);
    if (b - a < target.data.length) target.splitText(b - a);
    const mark = document.createElement("mark");
    mark.className = "acorn-hl";
    mark.dataset.id = String(h.id);
    mark.dataset.color = h.color;
    if (h.note) mark.dataset.note = "true";
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    if (!first) first = mark;
  }
  return first;
}

export function clearHighlights(root: HTMLElement): void {
  for (const m of root.querySelectorAll("mark.acorn-hl")) {
    const parent = m.parentNode!;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

/** Render all highlights into the article DOM. Returns ids that could not be anchored. */
export function renderHighlights(root: HTMLElement, list: Highlight[]): number[] {
  clearHighlights(root);
  const missing: number[] = [];
  for (const h of list) {
    const full = normalizeWithMap(textMap(root).text);
    const pos = anchor(full, h);
    if (!pos) {
      missing.push(h.id);
      continue;
    }
    wrap(root, pos[0], pos[1], h);
  }
  return missing;
}

export function flashHighlight(root: HTMLElement, id: number): void {
  const m = root.querySelector<HTMLElement>(`mark.acorn-hl[data-id="${id}"]`);
  if (!m) return;
  m.scrollIntoView({ behavior: "smooth", block: "center" });
  for (const el of root.querySelectorAll<HTMLElement>(`mark.acorn-hl[data-id="${id}"]`)) {
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }
}
