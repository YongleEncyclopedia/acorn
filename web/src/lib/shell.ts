import { useEffect } from "react";
import { getLocal, useLocalFlag } from "./local.ts";

const APP = "松果 Acorn";
const FOCUS_KEY = "acorn.focus";

/**
 * The browser tab says what is open ("文章标题 · 松果"). Pass undefined to leave the title to another component
 * (a list does while an article is open in front of it).
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title === undefined) return;
    document.title = title ? `${title} · 松果` : APP;
    return () => {
      document.title = APP;
    };
  }, [title]);
}

/**
 * Scroll a reading pane by one screenful (Space / Shift+Space), keeping a couple of lines in view as an anchor
 * for the eye. `pane` is the scrolling element on desktop; a phone (null) scrolls the page.
 * Returns false when there was nowhere further down to go, so the caller can move on to the next article.
 */
export function pageBy(pane: HTMLElement | null, dir: 1 | -1): boolean {
  const y = pane ? pane.scrollTop : window.scrollY;
  const view = pane ? pane.clientHeight : window.innerHeight;
  const max = (pane ? pane.scrollHeight : document.documentElement.scrollHeight) - view;
  if (dir > 0 && y >= max - 4) return false;
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  (pane || window).scrollBy({ top: dir * Math.max(120, view - 110), behavior });
  return true;
}

/**
 * 专注阅读: while an article is open, the navigation and the list step aside and the text has the window to
 * itself. A choice for this device (a phone always reads that way).
 */
export function useFocusMode(): [boolean, () => void] {
  const [on, set] = useLocalFlag(FOCUS_KEY);
  const toggle = () => {
    // read now rather than from the last render: two quick presses must cancel out
    const next = getLocal<string>(FOCUS_KEY, "0") !== "1";
    // The panes come and go at once and the text glides to its new place (reader.css, `data-focus-move`).
    // A view transition would do this too, but it has to snapshot the whole page first, and on a long article
    // that took the better part of a second before anything moved.
    const root = document.documentElement;
    root.dataset.focusMove = next ? "in" : "out";
    window.setTimeout(() => delete root.dataset.focusMove, 400);
    set(next);
  };
  return [on, toggle];
}
