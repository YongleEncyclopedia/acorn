import { useEffect, useRef, useState } from "react";
import { TR_ATTR } from "../../../src/shared/translate.ts";
import { useLayer } from "../lib/layers.ts";
import type { OutlineItem } from "../views/ArticleView.tsx";

/** An article needs a few sections before a table of contents is worth showing. */
export const OUTLINE_MIN = 3;

/** How far below the top of the reading area a heading counts as "the section you are in". */
const READING_LINE = 110;

/**
 * What stands in for a heading on screen: the heading itself, or — when the reader shows 只看译文 and the
 * original is hidden — the translation placed right after it.
 */
function onScreen(el: HTMLElement): HTMLElement {
  if (el.getClientRects().length) return el;
  const next = el.nextElementSibling as HTMLElement | null;
  return next?.hasAttribute(TR_ATTR) ? next : el;
}

/**
 * Which heading the reader is under: the last one that has passed the top of the reading area.
 * `scroller` is the reader pane on desktop; on a phone the page itself scrolls.
 */
export function useActiveHeading(items: OutlineItem[], scroller: React.RefObject<HTMLElement | null>, mobile: boolean): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (items.length < OUTLINE_MIN) return setActive(-1);
    const target: HTMLElement | Window | null = mobile ? window : scroller.current;
    if (!target) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // the pane can be gone by the time a queued frame runs (the next article is still loading)
      const pane = mobile ? null : scroller.current;
      if (!mobile && !pane) return;
      const line = (pane ? pane.getBoundingClientRect().top : 0) + READING_LINE;
      let at = -1;
      for (let i = 0; i < items.length; i += 1) {
        const rect = onScreen(items[i].el).getClientRects()[0];
        if (!rect) continue; // not displayed at all
        if (rect.top <= line) at = i;
        else break;
      }
      setActive(at);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      target.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, scroller, mobile]);
  return active;
}

export function jumpToHeading(item: OutlineItem): void {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  onScreen(item.el).scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

/** A heading as the page currently shows it: translated while the reader shows only the translation. */
export function headingLabel(item: OutlineItem): string {
  const el = onScreen(item.el);
  return el === item.el ? item.text : (el.textContent || "").replace(/\s+/g, " ").trim() || item.text;
}

/**
 * The outline at the edge of the reading pane: a quiet column of ticks, one per heading, that opens into the
 * list of sections when the pointer rests on it (or it is tapped, or reached with Tab).
 */
export function OutlineRail({ items, active, side = "right" }: { items: OutlineItem[]; active: number; side?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // A pointer on its way to the scrollbar crosses the rail; only one that lingers means to open it.
  const intent = useRef(0);
  const hover = (on: boolean) => {
    window.clearTimeout(intent.current);
    if (on) intent.current = window.setTimeout(() => setOpen(true), 140);
    else setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(intent.current), []);

  // Reached with the keyboard it is a layer of its own: Escape leaves the outline, not the article.
  useLayer(() => (document.activeElement as HTMLElement | null)?.blur(), open && focused);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (items.length < OUTLINE_MIN) return null;
  // Long outlines pack their ticks closer instead of running off the pane.
  const gap = Math.max(3, Math.min(9, Math.floor(380 / items.length) - 2));
  return (
    <nav
      ref={ref}
      className="outline"
      data-side={side}
      aria-label="目录"
      data-open={open}
      onPointerEnter={(e) => e.pointerType === "mouse" && hover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && hover(false)}
      onFocus={() => {
        setFocused(true);
        setOpen(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setFocused(false);
        setOpen(false);
      }}
    >
      {/* A tap focuses the button first on some browsers, which has already opened the list: a click only ever opens. */}
      <button className="outline-ticks" style={{ gap }} aria-label="目录" aria-expanded={open} onClick={() => setOpen(true)}>
        {items.map((h, i) => (
          <i key={i} data-depth={h.depth} data-active={i === active} />
        ))}
      </button>
      <ol ref={list} className="outline-list scroll" hidden={!open}>
        {open &&
          items.map((h, i) => (
            <li key={i}>
              <button
                data-depth={h.depth}
                aria-current={i === active ? "location" : undefined}
                onClick={(e) => {
                  jumpToHeading(h);
                  if (e.detail === 0) return; // from the keyboard: stay in the list
                  e.currentTarget.blur();
                }}
              >
                {headingLabel(h)}
              </button>
            </li>
          ))}
      </ol>
    </nav>
  );
}
