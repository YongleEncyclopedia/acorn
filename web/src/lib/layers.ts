import { useEffect, useRef } from "react";

/**
 * Things that sit on top of the page and take the keyboard while they are open: dialogs, popovers, the search
 * palette, the image viewer. While any is open the page's single-key shortcuts stay quiet, and Escape goes to
 * the one in front only — it used to close the menu and the article behind it in one press.
 */
const stack: symbol[] = [];

export const layerOpen = (): boolean => stack.length > 0;

/** Register an open layer. `onEscape` runs when Escape is pressed while this layer is the one in front. */
export function useLayer(onEscape?: () => void, active = true): void {
  const esc = useRef(onEscape);
  esc.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const id = Symbol("layer");
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || stack[stack.length - 1] !== id || !esc.current) return;
      e.preventDefault();
      esc.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Keep Tab inside `ref` while it is mounted and give the keyboard back to whatever had it before.
 * Focus starts on an [autofocus] / [data-autofocus] element if there is one, otherwise on the container itself,
 * so a screen reader begins at the dialog's title rather than at its close button.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active = true): void {
  // Noted while rendering: by the time effects run, an autoFocus field inside has already taken the focus.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined && typeof document !== "undefined") opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const before = opener.current ?? null;
    if (!root.contains(document.activeElement)) (root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") || root).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      restoreFocus(root, before);
    };
  }, [ref, active]);
}

/**
 * Give focus back to `to` once a layer has closed, unless the user has put it somewhere else in the meantime.
 * Called from effect clean-ups, which React also runs for a layer that is not going anywhere (Strict Mode
 * replays effects in development): one still in the document keeps its focus.
 */
export function restoreFocus(closed: HTMLElement, to: HTMLElement | null): void {
  if (closed.isConnected) return;
  const at = document.activeElement;
  if (to?.isConnected && (!at || at === document.body)) to.focus({ preventScroll: true });
}
