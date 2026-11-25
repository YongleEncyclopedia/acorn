/**
 * Changes made without a connection: read, 稍后读 and reading progress go to the server when it can be reached,
 * and wait on this device when it cannot (on the trail, on a plane), to be sent once it is back. Until then the
 * lists and articles on this device show them (`pending`), even when they come from the offline pack.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import { createStore } from "./store.ts";
import { addChange, dropFields, withChanges, type EntryChange, type Outbox } from "../../../src/shared/offline.ts";
import type { EntrySummary, Page } from "../../../src/shared/types.ts";

const KEY = "acorn.outbox";

function load(): Outbox {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Outbox;
  } catch {
    return {};
  }
}

export const outbox = createStore({ box: load() });

function save(box: Outbox): void {
  outbox.set({ box });
  try {
    if (Object.keys(box).length) localStorage.setItem(KEY, JSON.stringify(box));
    else localStorage.removeItem(KEY);
  } catch {
    /* kept for this session only */
  }
}

/** How many articles have changes waiting. */
export const usePending = (): number => outbox.use((s) => Object.keys(s.box).length);

type Change = Omit<EntryChange, "at">;

/** Change an article: on the server, or on this device until the server can be reached. "queued" means the latter. */
export async function patchEntry(id: number, change: Change): Promise<"sent" | "queued"> {
  try {
    await api.patchEntry(id, change);
    // what was just sent is no longer waiting (an older change to the same field must not be replayed over it)
    if (outbox.get().box[id]) save(dropFields(outbox.get().box, id, Object.keys(change)));
    return "sent";
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 0)) throw err;
    save(addChange(outbox.get().box, id, change));
    return "queued";
  }
}

/** An article as this device sees it, waiting changes included. */
export function pending<T extends Pick<EntrySummary, "id" | "readAt" | "starredAt" | "progress">>(entry: T): T {
  return withChanges(entry, outbox.get().box);
}

export function pendingPage(page: Page<EntrySummary>): Page<EntrySummary> {
  const box = outbox.get().box;
  return Object.keys(box).length ? { ...page, items: page.items.map((e) => withChanges(e, box)) } : page;
}

let flushing: Promise<number> | null = null;

/** Send what is waiting, oldest first. Stops at the first sign the server is still out of reach. */
export function flushOutbox(qc: QueryClient): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const waiting = Object.entries(outbox.get().box).sort((a, b) => a[1].at - b[1].at);
    for (const [id, c] of waiting) {
      const { at, ...change } = c;
      try {
        await api.patchEntry(Number(id), change);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 0 || status === 401 || status >= 500) break; // still offline, signed out, or the server failed: later
        // 404 (the article is gone) and other refusals: there is nothing left to send
      }
      // done with this article, unless it was changed again while this was on its way
      const now = outbox.get().box;
      if (now[id]?.at === at) {
        const rest = { ...now };
        delete rest[id];
        save(rest);
      }
      sent++;
    }
    if (sent) {
      qc.invalidateQueries({ queryKey: ["entries"] });
      qc.invalidateQueries({ queryKey: ["bootstrap"] });
    }
    return sent;
  })().finally(() => (flushing = null));
  return flushing;
}

/** Send waiting changes when the app opens, comes back to the screen, or the server answers again. */
export function useOutboxSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const go = () => {
      if (Object.keys(outbox.get().box).length) void flushOutbox(qc);
    };
    const onVisible = () => document.visibilityState === "visible" && go();
    go();
    window.addEventListener("online", go);
    window.addEventListener("acorn:reachable", go);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", go);
      window.removeEventListener("acorn:reachable", go);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
}
