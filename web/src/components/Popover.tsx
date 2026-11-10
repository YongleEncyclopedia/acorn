import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusables, restoreFocus, useLayer } from "../lib/layers.ts";

type Anchor = HTMLElement | DOMRect | { x: number; y: number } | null;

function rectOf(a: Anchor): DOMRect | null {
  if (!a) return null;
  if (a instanceof HTMLElement) return a.getBoundingClientRect();
  if (a instanceof DOMRect) return a;
  return new DOMRect(a.x, a.y, 0, 0);
}

/** Anchored floating panel rendered in a portal; closes on outside click and Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  placement = "bottom-end",
  className = "",
  label,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-end" | "bottom-start" | "top" | "bottom";
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayer(onClose);

  useLayoutEffect(() => {
    const r = rectOf(anchor);
    const el = ref.current;
    if (!r || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = placement === "top" ? r.top - h - 8 : r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    if (top < 8) top = Math.min(vh - h - 8, r.bottom + 6);
    let left = placement === "bottom-end" ? r.right - w : placement === "bottom-start" ? r.left : r.left + r.width / 2 - w / 2;
    left = Math.min(Math.max(8, left), vw - w - 8);
    setPos({ top, left });
  }, [anchor, placement]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose();
    };
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [anchor, onClose]);

  // Closing hands the keyboard back to the button that opened it.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el && anchor instanceof HTMLElement) restoreFocus(el, anchor);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos ? pos : { top: -9999, left: -9999 }} role="dialog" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shown as the chosen one of a set (a check mark instead of the icon). */
  checked?: boolean;
  /** Indent, for nested lists such as an article outline. */
  depth?: number;
  onSelect: () => void;
}

/** A list of actions. The first one takes focus when the menu opens; arrow keys, Home and End move between them. */
export function Menu({ items, onClose, note }: { items: (MenuItem | "sep")[]; onClose: () => void; note?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current && focusables(ref.current)[0];
    first?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || !ref.current) return;
    e.preventDefault();
    const list = focusables(ref.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  };
  return (
    <div ref={ref} role="menu" onKeyDown={onKeyDown}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role={it.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={it.checked}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            style={it.depth ? { paddingLeft: 10 + it.depth * 14 } : undefined}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon && <span className="ico">{it.icon}</span>}
            <span className="text">{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </button>
        ),
      )}
      {note && <div className="menu-note">{note}</div>}
    </div>
  );
}

/** Convenience hook: const m = useAnchor(); <button ref={m.ref} onClick={m.toggle}/> {m.open && <Popover anchor={m.el} .../>} */
export function useAnchor<T extends HTMLElement = HTMLButtonElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  return {
    ref: setEl,
    el,
    open,
    toggle: () => setOpen((o) => !o),
    close: () => setOpen(false),
    show: () => setOpen(true),
  };
}
