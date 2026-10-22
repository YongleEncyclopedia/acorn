/**
 * 搬家: move links in from other tools. Drop an export file (browser bookmarks, Pocket, Instapaper, Raindrop,
 * Readwise Reader, or any CSV / JSON / text with URLs), see what is in it, start; the server archives the links one
 * by one in the background and this dialog follows along. Past move-ins stay listed with what became of each link.
 */
import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Pause, Play, RotateCw, Trash2, Truck } from "lucide-react";
import { Dialog } from "./Dialog.tsx";
import { Switch } from "./Controls.tsx";
import { api } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { toast, toastError } from "../lib/store.ts";
import type { ImportBatch, ImportItemStatus, ImportPreview } from "../../../src/shared/types.ts";

const ACCEPT = ".html,.htm,.csv,.tsv,.json,.txt,.md";
const SHOWN: { key: ImportItemStatus; label: string }[] = [
  { key: "done", label: "已入藏" },
  { key: "rescued", label: "从 Internet Archive 找回" },
  { key: "skipped", label: "本来就在" },
  { key: "gone", label: "原文消失，没有副本" },
  { key: "failed", label: "失败" },
];

export function useImports() {
  return useQuery({
    queryKey: ["imports"],
    queryFn: api.imports,
    refetchInterval: (q) => (q.state.data?.some((b) => !b.finishedAt && !b.paused) ? 5000 : false),
  });
}

function Bar({ b }: { b: Pick<ImportBatch, "counts" | "total"> }) {
  return (
    <span className="progress" role="progressbar" aria-valuenow={b.total - b.counts.pending} aria-valuemin={0} aria-valuemax={b.total}>
      {SHOWN.map(({ key }) => b.counts[key] > 0 && <i key={key} className={key} style={{ width: `${(b.counts[key] / Math.max(1, b.total)) * 100}%` }} />)}
    </span>
  );
}

/** A strip on the 藏 page while links are being moved in. */
export function ImportProgress({ onOpen }: { onOpen: () => void }) {
  const q = useImports();
  const active = (q.data || []).filter((b) => !b.finishedAt);
  if (!active.length) return null;
  const sum = { total: 0, counts: { pending: 0, done: 0, rescued: 0, gone: 0, failed: 0, skipped: 0 } as Record<ImportItemStatus, number> };
  for (const b of active) {
    sum.total += b.total;
    for (const k of Object.keys(sum.counts) as ImportItemStatus[]) sum.counts[k] += b.counts[k];
  }
  const paused = active.every((b) => b.paused);
  return (
    <button className="movein-strip" onClick={onOpen}>
      {paused ? <Pause size={15} /> : <span className="spinner" />}
      <span>
        {paused ? "搬家已暂停" : "搬家进行中"} · {sum.total - sum.counts.pending} / {sum.total}
      </span>
      <Bar b={sum} />
    </button>
  );
}

function Batch({ b }: { b: ImportBatch }) {
  const qc = useQueryClient();
  const [show, setShow] = useState<ImportItemStatus | null>(null);
  const items = useQuery({ queryKey: ["import-items", b.id, show], queryFn: () => api.importItems(b.id, show!), enabled: !!show });
  const c = b.counts;
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg);
      qc.invalidateQueries({ queryKey: ["imports"] });
      qc.invalidateQueries({ queryKey: ["import-items", b.id] });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="batch">
      <div className="head">
        <b>{b.label}</b>
        <span className="muted">{b.finishedAt ? `完成于 ${relTime(b.finishedAt)}` : b.paused ? "已暂停" : `进行中 · ${b.total - c.pending} / ${b.total}`}</span>
        <span className="spacer" />
        {!b.finishedAt && (
          <button className="icon-btn sm" title={b.paused ? "继续" : "暂停"} aria-label={b.paused ? "继续" : "暂停"} onClick={() => act(() => api.patchImport(b.id, { paused: !b.paused }))}>
            {b.paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
        )}
        {c.failed > 0 && (
          <button className="btn sm" onClick={() => act(() => api.retryImport(b.id), "失败的链接已重新排队")}>
            <RotateCw size={14} />
            重试失败
          </button>
        )}
        <button
          className="icon-btn sm"
          title="删除这条记录（已入藏的文章保留）"
          aria-label="删除记录"
          onClick={() => window.confirm("删除这次搬家的记录？已经入藏的文章不受影响。") && act(() => api.deleteImport(b.id))}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <Bar b={b} />
      <div className="legend">
        {SHOWN.map(({ key, label }) =>
          c[key] > 0 ? (
            <button key={key} className={`chip ${key}`} aria-pressed={show === key} onClick={() => setShow(show === key ? null : key)}>
              <i /> {label} <span className="count">{c[key]}</span>
            </button>
          ) : null,
        )}
        {c.pending > 0 && <span className="muted small">还有 {c.pending} 个在排队</span>}
      </div>
      {show && (
        <ul className="batch-items">
          {items.data?.map((it) => (
            <li key={it.id} title={it.url}>
              {it.archiveId ? (
                <Link href={`/archive/${it.archiveId}`}>{it.title || it.url}</Link>
              ) : (
                <a href={it.url} target="_blank" rel="noopener noreferrer">
                  {it.title || it.url}
                </a>
              )}
              {it.error && <span className="muted"> · {it.error}</span>}
            </li>
          ))}
          {items.data && items.data.length === 0 && <li className="muted">没有</li>}
        </ul>
      )}
    </div>
  );
}

export function MoveIn({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState("");
  const [wayback, setWayback] = useState(true);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const batches = useImports();

  const pick = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      setPreview(await api.importPreview(fd));
    } catch (e) {
      toastError(e);
      setFile(null);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("tags", tags);
      fd.append("wayback", wayback ? "1" : "0");
      const b = await api.startImport(fd);
      toast(`开始搬家：${b.total - b.counts.skipped} 个链接会在后台逐个入藏`);
      setFile(null);
      setPreview(null);
      setTags("");
      qc.invalidateQueries({ queryKey: ["imports"] });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="搬家" size="lg" onClose={onClose} icon={<Truck size={18} />}>
      <div className="movein">
        <p className="lede">把别处收藏的链接一次搬进来。每个链接都会抓取正文、下载图片，存成你硬盘上的文件；原文已经消失的，还可以从 Internet Archive 找回当年的副本。</p>
        {!preview && (
          <div
            className={`dropzone ${over ? "over" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void pick(e.dataTransfer.files[0] || null);
            }}
          >
            <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void pick(e.target.files?.[0] || null)} />
            {busy ? <span className="spinner" /> : <FileUp size={22} />}
            <b>把导出文件拖到这里，或点击选择</b>
            <span>浏览器书签（Chrome、Safari、Firefox、Edge 导出的 HTML）、Pocket、Instapaper、Raindrop、Readwise Reader 的 CSV，或任何带网址的 CSV、JSON、文本文件</span>
          </div>
        )}
        {preview && (
          <div className="movein-preview">
            <div className="head">
              <b>{preview.label}</b>
              <button className="btn sm ghost" onClick={() => void pick(null)}>
                换一个文件
              </button>
            </div>
            <div className="nums">
              <span>
                <b>{preview.total}</b> 个链接
              </span>
              {preview.already > 0 && (
                <span>
                  <b>{preview.already}</b> 个已经在藏里，只补标签
                </span>
              )}
              {preview.skipped > 0 && <span className="muted">略过 {preview.skipped} 个重复或非网页地址</span>}
            </div>
            {preview.tags.length > 0 && (
              <div className="tags">
                {preview.tags.slice(0, 12).map((t) => (
                  <span key={t.tag} className="badge">
                    #{t.tag} {t.count}
                  </span>
                ))}
              </div>
            )}
            <ul className="sample">
              {preview.sample.map((s) => (
                <li key={s.url}>
                  <span>{s.title || s.url}</span>
                  {s.savedAt && <span className="muted">{relTime(s.savedAt)}</span>}
                </li>
              ))}
            </ul>
            <div className="form-grid">
              <div className="form-row">
                <label className="lbl">再加标签（可选）</label>
                <input className="field" placeholder="比如 pocket，或 2019" value={tags} onChange={(e) => setTags(e.target.value)} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>原文消失时，从 Internet Archive 找回</b>
                  <span>老链接很多早就 404 了。打开后会去 Wayback Machine 找离收藏时间最近的一份副本存下来</span>
                </div>
                <Switch checked={wayback} onChange={setWayback} />
              </div>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={busy || !preview.total} onClick={start}>
                {busy ? <span className="spinner" /> : `开始搬家（${preview.total} 个）`}
              </button>
            </div>
          </div>
        )}
        {batches.data?.length ? (
          <section className="batches">
            <h4>搬过的</h4>
            {batches.data.map((b) => (
              <Batch key={b.id} b={b} />
            ))}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
