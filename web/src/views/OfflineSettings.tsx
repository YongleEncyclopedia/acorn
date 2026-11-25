/**
 * 设置 → 离线阅读: download the offline pack (lib/offline.ts) to this device, and see what is waiting to be
 * synced (lib/outbox.ts). Each device keeps its own pack; the options are this device's too (lib/local.ts).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { bytes, fullDate } from "../lib/format.ts";
import { useLocal, useLocalFlag } from "../lib/local.ts";
import { toast, toastError } from "../lib/store.ts";
import { connection } from "../lib/connection.ts";
import { clearPack, downloadPack, offlineBlocker, usePackInfo, useStorage, type PackProgress } from "../lib/offline.ts";
import { flushOutbox, usePending } from "../lib/outbox.ts";
import { Segmented, Switch } from "../components/Controls.tsx";
import type { Settings } from "../../../src/shared/types.ts";

const COUNTS = ["50", "100", "200", "500"] as const;
const FONT_NAMES = { serif: "宋体", kai: "文楷" } as const;

const STAGES: Record<PackProgress["stage"], string> = {
  app: "正在存界面和字体",
  lists: "正在整理文章列表",
  articles: "正在存文章和图片",
  finishing: "正在存缩略图和图标",
};

function Blocked({ why }: { why: NonNullable<ReturnType<typeof offlineBlocker>> }) {
  if (why === "dev") return <span>开发模式下没有离线功能：先 npm run build，再用 npm start 打开。</span>;
  if (why === "unsupported") return <span>这个浏览器不能为网页存离线内容，换用 Safari 或 Chrome 打开松果。</span>;
  return (
    <span>
      浏览器只允许 https 网址在设备上存离线内容，现在打开松果的是 <code>{window.location.origin}</code>。用 Tailscale 给的 https 地址（在运行松果的电脑上开启
      tailscale serve），或者给松果配一个 https 域名，再在那个地址上下载。
    </span>
  );
}

export function OfflineSettings({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [unread, setUnread] = useLocal<(typeof COUNTS)[number]>("acorn.offline.unread", "100", COUNTS);
  const [images, setImages] = useLocalFlag("acorn.offline.images", true);
  const [fonts, setFonts] = useLocalFlag("acorn.offline.fonts", true);
  const [run, setRun] = useState<{ progress: PackProgress; abort: AbortController } | null>(null);
  const info = usePackInfo();
  const pending = usePending();
  const offline = connection.use((c) => c.offline);
  const blocker = offlineBlocker();
  const storage = useStorage([info?.at, !!run]);
  const assets = useQuery({ queryKey: ["offline-assets"], queryFn: api.offlineAssets, enabled: !blocker, staleTime: 10 * 60_000 });
  const font = s.reader.font === "serif" || s.reader.font === "kai" ? s.reader.font : null;

  const start = async () => {
    const abort = new AbortController();
    setRun({ progress: { stage: "app", done: 0, total: 0, bytes: 0 }, abort });
    try {
      const r = await downloadPack({ unread: Number(unread), images, fonts }, (progress) => setRun((cur) => cur && { ...cur, progress }), abort.signal);
      if (r.complete) toast(`离线包存好了：${r.articles} 篇文章${r.note ? `。${r.note}` : ""}`);
      else toast(r.note || "离线包没有下完", { kind: "error" });
    } catch (e) {
      toastError(e);
    } finally {
      setRun(null);
    }
  };
  const clear = async () => {
    await clearPack().catch(toastError);
    toast("离线包已清除");
  };
  const sync = async () => {
    const sent = await flushOutbox(qc);
    if (!sent) toast("还连不上松果，改动会在联网后自动同步", { kind: "error" });
  };

  const p = run?.progress;
  return (
    <section className="settings-section" id="offline">
      <h2>离线阅读</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>离线包</b>
            <span>进山、坐飞机之前，把要读的文章连同图片存进这台设备，没有网也能打开松果接着读。标为已读、加入稍后读和阅读进度会先记在设备上，连上松果后自动同步。每台设备各自下载。</span>
          </div>
          {blocker ? (
            <p className="offline-blocked">
              <Blocked why={blocker} />
            </p>
          ) : (
            <>
              <div className="offline-options">
                <span className="offline-label">未读</span>
                <div className="offline-cell">
                  <Segmented value={unread} onChange={setUnread} options={COUNTS.map((n) => ({ value: n, label: `${n} 篇` }))} />
                  <p className="offline-help">按「未读」列表的顺序取；「稍后读」和「在读」的文章总是全部带上。</p>
                </div>
                <span className="offline-label">图片</span>
                <div className="offline-cell row">
                  <Switch checked={images} onChange={setImages} />
                  <span className="offline-help">文章里的图片和列表缩略图，占的空间最多</span>
                </div>
                {font && (
                  <>
                    <span className="offline-label">字体</span>
                    <div className="offline-cell row">
                      <Switch checked={fonts} onChange={setFonts} />
                      <span className="offline-help">
                        阅读用的{FONT_NAMES[font]}
                        {assets.data ? `，约 ${bytes(assets.data.bytes[font])}` : ""}，只下载一次；不带的话用系统自带的字体显示
                      </span>
                    </div>
                  </>
                )}
              </div>

              {p ? (
                <div className="offline-progress" role="status">
                  <div className="offline-bar">
                    <div style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} />
                  </div>
                  <div className="bridge-status">
                    <span className="muted">
                      {STAGES[p.stage]}
                      {p.total ? ` ${p.done} / ${p.total}` : ""} · 已下载 {bytes(p.bytes)}
                    </span>
                    <div className="offline-actions">
                      <button type="button" className="btn sm ghost" onClick={() => run?.abort.abort()}>
                        <X size={14} />
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bridge-status">
                  <span className={info && !info.complete ? "bad" : "muted"}>
                    {info
                      ? `${info.complete ? "上次" : "没有下完"}：${fullDate(info.at)} · ${info.articles} 篇 · ${info.images} 张新图片${info.skipped ? `（${info.skipped} 张没取到）` : ""} · 下载了 ${bytes(info.bytes)}${info.note ? `。${info.note}` : ""}`
                      : "这台设备上还没有离线包"}
                  </span>
                  <div className="offline-actions">
                    {info && (
                      <button type="button" className="btn sm ghost" onClick={clear}>
                        清除
                      </button>
                    )}
                    <button type="button" className="btn sm primary" onClick={start} disabled={offline}>
                      <CloudDownload size={15} />
                      {info ? "更新离线包" : "下载离线包"}
                    </button>
                  </div>
                </div>
              )}
              {storage && (
                <p className="offline-help">
                  松果在这台设备上占用 {bytes(storage.usage)}，最多还能存约 {bytes(Math.max(0, storage.quota - storage.usage))}。
                </p>
              )}
            </>
          )}
        </div>
        {pending > 0 && (
          <div className="setting-row">
            <div className="txt">
              <b>{pending} 篇文章的改动等待同步</b>
              <span>离线时标的已读、稍后读和阅读进度，连上松果后会自动发过去。</span>
            </div>
            <button type="button" className="btn sm" onClick={sync}>
              现在同步
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
