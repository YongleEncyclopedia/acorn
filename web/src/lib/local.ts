import { useCallback, useSyncExternalStore } from "react";

/**
 * Small settings that belong to this device rather than to the library (how dense the list is on this screen,
 * whether the side panes are hidden while reading here). Kept in localStorage; every component reading the same
 * key updates together, including in other tabs.
 */
const listeners = new Map<string, Set<() => void>>();
// Where storage is unavailable (private mode, blocked cookies) a setting still holds until the page is closed.
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function subscribe(key: string, fn: () => void): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(fn);
  const onStorage = (e: StorageEvent) => e.key === key && fn();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.get(key)?.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function getLocal<T extends string>(key: string, fallback: T, allowed?: readonly T[]): T {
  const v = read(key) as T | null;
  return v !== null && (!allowed || allowed.includes(v)) ? v : fallback;
}

export function setLocal(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kept in memory only */
  }
  for (const fn of listeners.get(key) || []) fn();
}

/** `allowed` guards against values written by an older version. */
export function useLocal<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    useCallback((fn) => subscribe(key, fn), [key]),
    () => getLocal(key, fallback, allowed),
  );
  const set = useCallback((v: T) => setLocal(key, v), [key]);
  return [value, set];
}

export function useLocalFlag(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [v, set] = useLocal<"1" | "0">(key, fallback ? "1" : "0", ["1", "0"]);
  return [v === "1", useCallback((on: boolean) => set(on ? "1" : "0"), [set])];
}
