import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { CloudOff, RefreshCw } from "lucide-react";
import { connection } from "../lib/connection.ts";
import { usePackInfo } from "../lib/offline.ts";
import { usePending } from "../lib/outbox.ts";

const day = (t: number) => `${new Date(t).getMonth() + 1}月${new Date(t).getDate()}日`;

/** While the server cannot be reached, or changes made meanwhile are still waiting: what is showing, and what will sync. */
export function OfflineChip() {
  const offline = connection.use((c) => c.offline);
  const pending = usePending();
  const pack = usePackInfo();
  const [, navigate] = useLocation();
  if (!offline && !pending) return null;
  const what = offline ? (pack ? `离线 · ${day(pack.at)}的离线包` : "离线 · 只能看打开过的文章") : "";
  const waiting = pending ? `${pending} 篇的改动待同步` : "";
  return createPortal(
    <button type="button" className="offline-chip" role="status" onClick={() => navigate("/settings#offline")} title="离线阅读设置">
      {offline ? <CloudOff size={14} /> : <RefreshCw size={13} />}
      <span>{[what, waiting].filter(Boolean).join(" · ")}</span>
    </button>,
    document.body,
  );
}
