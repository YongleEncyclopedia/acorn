import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "../../../src/shared/types.ts";
import { keys } from "./queries.ts";
import { toast, ui } from "./store.ts";

/**
 * Subscribe to the server event stream and keep caches fresh.
 *
 * A page in the back/forward cache keeps its open requests, and each event stream left open there holds one of the
 * six HTTP/1.1 connections a browser allows per host: after a few full loads in one tab, the live page's requests
 * found none free and waited. So the stream closes on `pagehide` and reopens when the page comes back from the cache
 * (`pageshow` with `persisted`), refetching what the page missed meanwhile. Chromium also evicts a cached page whose
 * request is still open after a minute, so closing it keeps Back instant.
 */
export function useServerEvents(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry = 1000;
    let retryTimer = 0;
    let countsTimer = 0;
    let importTimer = 0;
    const refreshCounts = () => {
      window.clearTimeout(countsTimer);
      countsTimer = window.setTimeout(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), 400);
    };
    const disconnect = () => {
      window.clearTimeout(retryTimer);
      es?.close();
      es = null;
    };
    const connect = () => {
      disconnect();
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
          case "backup":
            qc.invalidateQueries({ queryKey: ["backup"] });
            if (!ev.running) toast(ev.ok ? "备份完成" : `备份失败：${ev.error || "未知原因"}`, ev.ok ? undefined : { kind: "error" });
            break;
          case "import":
            // one event per link; the lists only need to catch up every so often
            window.clearTimeout(importTimer);
            importTimer = window.setTimeout(() => {
              qc.invalidateQueries({ queryKey: ["imports"] });
              qc.invalidateQueries({ queryKey: ["import-items"] });
              qc.invalidateQueries({ queryKey: ["archives"] });
            }, 600);
            refreshCounts();
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
        disconnect();
        retryTimer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    const onPageHide = () => disconnect();
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      retry = 1000;
      connect();
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    connect();
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      disconnect();
      window.clearTimeout(countsTimer);
      window.clearTimeout(importTimer);
    };
  }, [enabled, qc]);
}
