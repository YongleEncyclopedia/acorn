import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "../../../src/shared/types.ts";
import { keys } from "./queries.ts";
import { toast, ui } from "./store.ts";

/** Subscribe to the server event stream and keep caches fresh. */
export function useServerEvents(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry = 1000;
    let closed = false;
    let countsTimer = 0;
    const refreshCounts = () => {
      window.clearTimeout(countsTimer);
      countsTimer = window.setTimeout(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), 400);
    };
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => (retry = 1000);
      es.onmessage = (msg) => {
        if (!msg.data) return;
        let ev: ServerEvent;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          return;
        }
        switch (ev.type) {
          case "entries":
            ui.set((s) => ({ freshEntries: s.freshEntries + ev.added }));
            refreshCounts();
            break;
          case "feed":
          case "counts":
            refreshCounts();
            break;
          case "fulltext":
            qc.invalidateQueries({ queryKey: keys.entry(ev.entryId) });
            break;
          case "archive":
            if (ev.status === "done") {
              qc.invalidateQueries({ queryKey: ["archives"] });
              qc.invalidateQueries({ queryKey: ["entry"] });
              qc.invalidateQueries({ queryKey: ["archive"] });
              refreshCounts();
              if (ev.title) toast(`已入藏 · ${ev.title}`);
            } else if (ev.status === "verify") {
              qc.invalidateQueries({ queryKey: ["pending-verify"] });
            } else if (ev.status === "error") {
              toast(`入藏失败：${ev.error || ev.url}`, { kind: "error" });
            }
            break;
        }
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [enabled, qc]);
}
