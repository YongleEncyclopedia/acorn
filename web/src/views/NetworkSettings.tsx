/** 设置 → 网络: the proxy the server goes through to reach sites blocked where it runs (Nikkei, Reddit, OpenAI…). */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { toastError } from "../lib/store.ts";
import { Segmented } from "../components/Controls.tsx";
import type { NetworkSettings, Settings } from "../../../src/shared/types.ts";

export function NetworkSection({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const n = s.network;
  const status = useQuery({ queryKey: ["network"], queryFn: api.network });
  const [url, setUrl] = useState(n.url);
  const [bypass, setBypass] = useState(n.bypass);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => setUrl(n.url), [n.url]);
  useEffect(() => setBypass(n.bypass), [n.bypass]);
  const apply = async (patch: Partial<NetworkSettings>) => {
    await save({ network: { ...n, ...patch } });
    setTest(null);
    await status.refetch();
  };
  const runTest = async () => {
    setTesting(true);
    try {
      const r = await api.networkTest();
      setTest({ ok: r.ok, text: r.ok ? `能连上外网（${r.ms} 毫秒，${r.via ? `经过 ${r.via}` : "直连"}）` : `连不上外网：${r.error || `HTTP ${r.status}`}` });
    } catch (e) {
      toastError(e);
    } finally {
      setTesting(false);
    }
  };
  const st = status.data;
  return (
    <section className="settings-section" id="network">
      <h2>网络</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>代理</b>
            <span>在中国大陆，日经、Reddit、YouTube、OpenAI 这些境外网站要经过代理才连得上。松果的抓取、图片、翻译都走这里设的代理；本机的服务（Ollama、RSSHub）和下面的例外直连。</span>
          </div>
          <Segmented
            value={n.proxy}
            onChange={(v) => void apply({ proxy: v })}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "manual", label: "手动填写" },
              { value: "off", label: "不用代理" },
            ]}
          />
          {n.proxy === "manual" && (
            <input className="field mono" placeholder="http://127.0.0.1:7897" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== n.url && void apply({ url })} onKeyDown={(e) => e.key === "Enter" && void apply({ url })} />
          )}
          <div className="bridge-status">
            <span className={st && !st.supported ? "bad" : "muted"}>
              {!st
                ? "…"
                : !st.supported
                  ? "运行松果的 Node 太旧，用不了代理（需要 Node 24 或更新）"
                  : st.active
                    ? `正在用 ${st.active}`
                    : n.proxy === "system"
                      ? "这台电脑没有设代理，现在直连"
                      : "现在直连"}
              {test && <span className={test.ok ? "" : "bad"}> · {test.text}</span>}
            </span>
            <span className="grow" />
            <button type="button" className="btn sm" disabled={testing} onClick={runTest}>
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
              例外（直连的地址）
            </summary>
            <input className="field mono" style={{ marginTop: 8 }} value={bypass} onChange={(e) => setBypass(e.target.value)} onBlur={() => bypass !== n.bypass && void apply({ bypass })} placeholder="localhost, 127.0.0.1, ::1, .local, .sjtu.edu.cn" />
          </details>
        </div>
      </div>
    </section>
  );
}
