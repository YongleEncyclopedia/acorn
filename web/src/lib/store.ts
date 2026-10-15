import { useSyncExternalStore } from "react";

/** A tiny global store (no dependencies). */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (patch: Partial<T> | ((s: T) => Partial<T>)) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    use<S>(selector: (s: T) => S): S {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(this.subscribe, () => selector(state), () => selector(state));
    },
  };
}

export interface Toast {
  id: number;
  text: string;
  kind?: "info" | "error";
  action?: { label: string; run: () => void };
}

export const ui = createStore({
  toasts: [] as Toast[],
  palette: false,
  drawer: false,
  notesPanel: false,
  addSource: null as null | { input?: string },
  lightbox: null as null | string,
  freshEntries: 0,
});

let toastId = 0;
export function toast(text: string, opts: { kind?: "info" | "error"; action?: Toast["action"]; ms?: number } = {}): void {
  const id = ++toastId;
  ui.set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind: opts.kind, action: opts.action }] }));
  setTimeout(() => ui.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), opts.ms ?? (opts.kind === "error" ? 6000 : 3200));
}

export function toastError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), { kind: "error" });
}
