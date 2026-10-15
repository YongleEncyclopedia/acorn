import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Globe, Rss } from "lucide-react";
import { api } from "../lib/api.ts";
import { useBootstrap } from "../lib/queries.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { Layout } from "./Layout.tsx";
import { Seal } from "../components/Seal.tsx";
import { hostname } from "../lib/format.ts";

/** Landing page for the bookmarklet, the Android share sheet and iOS Shortcuts: /capture?url=…&title=… */
export function CapturePage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const boot = useBootstrap();
  const p = new URLSearchParams(search);
  const url = useMemo(() => {
    const direct = p.get("url") || "";
    if (/^https?:\/\//.test(direct)) return direct;
    return (p.get("text") || "").match(/https?:\/\/[^\s]+/)?.[0] || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const title = p.get("title") || "";
  const [busy, setBusy] = useState<"" | "fetch" | "browser">("");
  const go = async (method: "fetch" | "browser") => {
    setBusy(method);
    try {
      const r = await api.capture({ url, method, wait: true });
      toast(r.unchanged ? "已经藏过了，内容没有变化" : "已入藏");
      if (r.archiveId) navigate(`/archive/${r.archiveId}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <Layout mode="wide">
      <main className="pane wide-pane">
        <div className="page narrow" style={{ paddingTop: 60 }}>
          <div className="auth-card" style={{ margin: "0 auto" }}>
            <Seal stamp />
            <h1 style={{ fontSize: 26 }}>收进松果</h1>
            {url ? (
              <>
                <p style={{ wordBreak: "break-all" }}>
                  <b style={{ color: "var(--ink)", display: "block", fontSize: 16, marginBottom: 4 }}>{title || hostname(url)}</b>
                  {url}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                  <button className="btn primary lg" onClick={() => go("fetch")} disabled={!!busy}>
                    {busy === "fetch" ? <span className="spinner" /> : <Seal size="xs" />}
                    入藏
                  </button>
                  {boot.data?.egoBrowser && (
                    <button className="btn lg" onClick={() => go("browser")} disabled={!!busy}>
                      {busy === "browser" ? <span className="spinner" /> : <Globe size={17} />}
                      用电脑上的浏览器入藏
                    </button>
                  )}
                  <button className="btn ghost lg" onClick={() => ui.set({ addSource: { input: url } })} disabled={!!busy}>
                    <Rss size={17} />
                    订阅这个网站
                  </button>
                </div>
              </>
            ) : (
              <p>没有收到网址。可以从浏览器的书签小工具、手机分享菜单或快捷指令打开这个页面。</p>
            )}
          </div>
        </div>
      </main>
    </Layout>
  );
}
