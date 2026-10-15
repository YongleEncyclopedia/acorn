import { useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, X } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { hostname } from "../lib/format.ts";
import { toast, toastError } from "../lib/store.ts";
import { keys } from "../lib/queries.ts";

/**
 * Browser captures waiting for the user to pass a captcha / login. The page was handed to the user in ego-browser;
 * once they pass it there, "继续入藏" takes the page back and archives it.
 */
export function VerifyBanner() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["pending-verify"], queryFn: api.pendingVerify, refetchInterval: 60_000 });
  const list = q.data || [];
  if (!list.length) return null;
  const p = list[0];
  const resume = async () => {
    setBusy(p.spaceId);
    try {
      const r = await api.resumeCapture(p.spaceId);
      toast(`已入藏 · ${r.title}`);
      qc.invalidateQueries({ queryKey: ["archives"] });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
      navigate(`/archive/${r.archiveId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) toast(e.message, { kind: "error" });
      else toastError(e);
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["pending-verify"] });
    }
  };
  const drop = async () => {
    await api.dropPending(p.spaceId).catch(toastError);
    qc.invalidateQueries({ queryKey: ["pending-verify"] });
  };
  return createPortal(
    <div className="verify-banner" role="status">
      <ShieldCheck size={20} />
      <div className="txt">
        <b>{p.title || hostname(p.url) || "一个网页"}需要你验证{list.length > 1 ? `（还有 ${list.length - 1} 个）` : ""}</b>
        <span>
          {p.reason}。在 ego 浏览器里已经打开了这一页，完成验证、看到正文后点「继续入藏」。
        </span>
      </div>
      <button className="btn sm primary" onClick={resume} disabled={busy !== null}>
        {busy !== null ? <span className="spinner" /> : "继续入藏"}
      </button>
      <button className="icon-btn sm" onClick={drop} aria-label="忽略" title="忽略">
        <X size={16} />
      </button>
    </div>,
    document.body,
  );
}
