import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-end" | "bottom-start" | "top" | "bottom";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos ? pos : { top: -9999, left: -9999 }} role="dialog">
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
  onSelect: () => void;
}

export function Menu({ items, onClose, note }: { items: (MenuItem | "sep")[]; onClose: () => void; note?: ReactNode }) {
  return (
    <div role="menu">
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon && <span className="ico">{it.icon}</span>}
            <span>{it.label}</span>
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
