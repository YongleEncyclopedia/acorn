import { useEffect, useRef } from "react";

type Handler = (e: KeyboardEvent) => void;

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/**
 * Register single-key shortcuts ("j", "shift+a", "mod+k", "g u" sequences).
 * Ignored while typing in a field (except mod+ combinations).
 */
export function useHotkeys(map: Record<string, Handler>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    let prefix = "";
    let timer = 0;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (typing(e) && !mod) return;
      if (e.isComposing) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const combo = `${mod ? "mod+" : ""}${e.shiftKey && e.key.length > 1 ? "shift+" : e.shiftKey && /[a-z]/i.test(e.key) ? "shift+" : ""}${key}`;
      const seq = prefix ? `${prefix} ${key}` : "";
      const fn = (seq && ref.current[seq]) || ref.current[combo];
      if (fn) {
        e.preventDefault();
        prefix = "";
        fn(e);
        return;
      }
      if (!mod && Object.keys(ref.current).some((k) => k.startsWith(`${key} `))) {
        prefix = key;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (prefix = ""), 900);
      } else prefix = "";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
