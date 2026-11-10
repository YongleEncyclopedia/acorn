import { useEffect, useRef } from "react";
import { layerOpen } from "./layers.ts";

type Handler = (e: KeyboardEvent) => void;
type KeyMap = Record<string, Handler>;

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

const CONTROL = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="switch"], [role="link"]';

// The control that has focus because it was clicked (not reached with Tab), if any.
let clicked: Element | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => (clicked = (e.target as Element | null)?.closest?.(CONTROL) ?? null), true);
  window.addEventListener("keydown", (e) => e.key === "Tab" && (clicked = null), true);
}

/**
 * Space and Enter already mean "press this" on a control reached with the keyboard; they must not also page the
 * article. A button that merely kept focus after being clicked does not count: once you have clicked 稍后读,
 * Space goes back to turning the page instead of un-starring the article.
 * (`:focus-visible` cannot tell the two apart here: browsers turn it on at the first key press.)
 */
function pressing(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  // a podcast's player keeps Space for play / pause however it got its focus
  if (target?.closest?.("audio, video")) return true;
  const control = target?.closest?.(CONTROL);
  return !!control && control !== clicked;
}

/** The name a key press goes by in a shortcut map: "j", "shift+a", "mod+k", "space", "shift+space", "?". */
export function comboOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">): { key: string; combo: string } {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key === " " ? "space" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Shift is part of the name for letters and named keys; for symbols ("?") the symbol already says it.
  const shift = e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key));
  return { key, combo: `${mod ? "mod+" : ""}${shift ? "shift+" : ""}${key}` };
}

interface Registration {
  map: { current: KeyMap };
  overlay: boolean;
}

// One listener and one pending prefix for the whole app. Each component used to listen on its own, so "g a"
// (go to the archive) also ran the reader's "a" (archive this article): whichever map saw the key first won.
const registry: Registration[] = [];
let prefix = "";
let prefixTimer = 0;

function dispatch(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.altKey) return;
  const mod = e.metaKey || e.ctrlKey;
  if (typing(e) && !mod) return;
  const { key, combo } = comboOf(e);
  if ((key === "space" || key === "Enter") && pressing(e)) return;
  const layered = layerOpen();
  // Later registrations (the component opened most recently) are asked first.
  const maps = registry.filter((r) => r.overlay || !layered).map((r) => r.map.current).reverse();
  const find = (name: string) => maps.find((m) => m[name])?.[name];
  const pending = prefix;
  prefix = "";
  window.clearTimeout(prefixTimer);
  const fn = (pending && !mod ? find(`${pending} ${key}`) : undefined) || find(combo);
  if (fn) {
    e.preventDefault();
    fn(e);
  } else if (!mod && maps.some((m) => Object.keys(m).some((k) => k.startsWith(`${key} `)))) {
    prefix = key;
    prefixTimer = window.setTimeout(() => (prefix = ""), 900);
  }
}

/**
 * Register keyboard shortcuts: single keys ("j"), combinations ("shift+a", "mod+k") and sequences ("g u").
 * They are ignored while typing in a field (except mod+ combinations) and while a dialog, menu or the image
 * viewer is open — pass `overlay: true` for the few that belong to such a layer or must work above it.
 */
export function useHotkeys(map: KeyMap, enabled = true, opts: { overlay?: boolean } = {}): void {
  const ref = useRef(map);
  ref.current = map;
  const overlay = !!opts.overlay;
  useEffect(() => {
    if (!enabled) return;
    const reg: Registration = { map: ref, overlay };
    if (!registry.length) window.addEventListener("keydown", dispatch);
    registry.push(reg);
    return () => {
      registry.splice(registry.indexOf(reg), 1);
      if (!registry.length) window.removeEventListener("keydown", dispatch);
    };
  }, [enabled, overlay]);
}
