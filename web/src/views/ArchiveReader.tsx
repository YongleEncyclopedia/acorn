import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Camera, Copy, ExternalLink, FileCode2, FileDown, FileText, Globe, Languages, LifeBuoy, MoreHorizontal, RefreshCcw, RotateCw, Sparkles, Trash2, Type } from "lucide-react";
import { Layout } from "./Layout.tsx";
import { ArticleView, type ArticleHandle } from "./ArticleView.tsx";
import { TranslateStatus } from "../components/TranslateStatus.tsx";
import { SummaryCard, useSummary } from "../components/SummaryCard.tsx";
import { useReaderTranslation } from "../lib/translate.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { ReaderPrefsPanel, usePrefs } from "./ReaderPrefs.tsx";
import { api } from "../lib/api.ts";
import { useBootstrap, keys } from "../lib/queries.ts";
import { bytes, fullDate, hostname, relTime } from "../lib/format.ts";
import { readerStyle } from "../lib/theme.ts";
import { toast, toastError } from "../lib/store.ts";
import { useMobile } from "../lib/useMedia.ts";
import { Popover, Menu, useAnchor } from "../components/Popover.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty } from "../components/Empty.tsx";
import type { ArchiveDetail } from "../../../src/shared/types.ts";

const METHOD: Record<string, string> = { fetch: "服务器抓取", browser: "浏览器快照", feed: "订阅源全文", import: "手动导入", wayback: "Internet Archive 副本" };
const STATUS: Record<string, { label: string; cls: string }> = {
  alive: { label: "原文仍在", cls: "ok" },
  changed: { label: "原文改过", cls: "warn" },
  gone: { label: "原文已消失", cls: "red" },
  unknown: { label: "暂时无法确认", cls: "" },
};

function Aside({ a, snapshotId, onSnapshot, onChanged }: { a: ArchiveDetail; snapshotId: number; onSnapshot: (id: number) => void; onChanged: () => void }) {
  const [tagInput, setTagInput] = useState("");
  const [note, setNote] = useState(a.note || "");
  useEffect(() => setNote(a.note || ""), [a.id, a.note]);
  const snap = a.snapshots.find((s) => s.id === snapshotId) || a.snapshots[0];
  const saveTags = async (tags: string[]) => {
    await api.patchArchive(a.id, { tags }).catch(toastError);
    onChanged();
  };
  const st = STATUS[a.sourceStatus] || STATUS.unknown;
  return (
    <aside className="archive-aside">
      <section>
        <h4>原文</h4>
        <div className="kv">
          <span className={`badge ${st.cls}`}>{st.label}</span>
          {a.sourceCheckedAt && <span className="muted">· {relTime(a.sourceCheckedAt)}检查</span>}
        </div>
        <a className="link-line" href={a.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} />
          <span>{hostname(a.url) || a.url}</span>
        </a>
        {a.goneAt && <p className="muted small">在 {fullDate(a.goneAt)} 发现原文已不可访问。</p>}
      </section>
      <section>
        <h4>版本 · {a.snapshots.length}</h4>
        <div className="timeline">
          {a.snapshots.map((s) => (
            <button key={s.id} aria-current={s.id === snap?.id} onClick={() => onSnapshot(s.id)}>
              <span className="node" />
              <span>
                {fullDate(s.capturedAt)}
                <span className="muted small" style={{ display: "block" }}>
                  {METHOD[s.method] || s.method} · {s.assets} 张图 · {bytes(s.bytes)}
                </span>
              </span>
              {s.status === "partial" && <span className="badge warn">缺图</span>}
            </button>
          ))}
        </div>
        {snap?.warnings.length ? <p className="muted small" style={{ marginTop: 8 }}>{snap.warnings.join("；")}</p> : null}
      </section>
      {snap && (
        <section>
          <h4>本地文件</h4>
          <div className="files">
            <a href={snap.files.article} target="_blank" rel="noopener">
              <FileText size={14} /> 离线阅读页
            </a>
            <a href={snap.files.markdown} target="_blank" rel="noopener">
              <FileDown size={14} /> Markdown
            </a>
            {snap.files.source && (
              <a href={snap.files.source} target="_blank" rel="noopener">
                <FileCode2 size={14} /> 原始网页
              </a>
            )}
            {snap.files.mhtml && (
              <a href={snap.files.mhtml}>
                <Globe size={14} /> 整页快照 MHTML
              </a>
            )}
            {snap.files.screenshot && (
              <a href={snap.files.screenshot} target="_blank" rel="noopener">
                <Camera size={14} /> 整页截图
              </a>
            )}
          </div>
          <button
            className="code-line"
            style={{ marginTop: 10, width: "100%", textAlign: "left" }}
            title="复制文件夹路径"
            onClick={() => navigator.clipboard?.writeText(a.absolutePath).then(() => toast("已复制路径，可以在访达中前往"))}
          >
            <span>{a.absolutePath}</span>
            <Copy size={13} />
          </button>
        </section>
      )}
      <section>
        <h4>标签</h4>
        <div className="tags">
          {a.tags.map((t) => (
            <button key={t} className="chip" onClick={() => saveTags(a.tags.filter((x) => x !== t))} title="点击移除">
              #{t} ×
            </button>
          ))}
          <input
            className="field"
            style={{ height: 30, width: 120 }}
            placeholder="添加标签"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagInput.trim()) {
                saveTags([...a.tags, tagInput.trim()]);
                setTagInput("");
              }
            }}
          />
        </div>
      </section>
      <section>
        <h4>备注</h4>
        <textarea
          className="field"
          rows={4}
          placeholder="为什么藏它？"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (a.note || "") && api.patchArchive(a.id, { note: note || null }).then(onChanged, toastError)}
        />
      </section>
    </aside>
  );
}

export function ArchiveReader({ id }: { id: number }) {
  const [snapshotId, setSnapshotId] = useState(0);
  const q = useQuery({ queryKey: keys.archive(id, snapshotId), queryFn: () => api.archive(id, snapshotId || undefined) });
  const qc = useQueryClient();
  const boot = useBootstrap();
  const [, navigate] = useLocation();
  const [prefs] = usePrefs();
  const mobile = useMobile();
  const more = useAnchor();
  const prefsMenu = useAnchor();
  const article = useRef<ArticleHandle>(null);
  const a = q.data;
  const changed = () => {
    qc.invalidateQueries({ queryKey: ["archive", id] });
    qc.invalidateQueries({ queryKey: ["archives"] });
  };
  const snap = a ? a.snapshots.find((s) => s.id === snapshotId) || a.snapshots[0] : undefined;
  const trCfg = boot.data?.settings.translate;
  const tr = useReaderTranslation(article, { id: `archive:${id}:${snap?.id || 0}`, html: a?.content || "", title: a?.title || "", cfg: trCfg });
  const tldr = useSummary({ archiveId: id }, `${id}:${snap?.id || 0}`, !!a);
  useHotkeys({ t: tr.toggle, i: tldr.toggle }, !!a);

  const recapture = async (method: "fetch" | "browser") => {
    try {
      await api.snapshot(id, method);
      toast(method === "browser" ? "正在用你的浏览器重新入藏…" : "正在保存新版本…");
    } catch (e) {
      toastError(e);
    }
  };
  const recheck = async () => {
    try {
      const r = await api.recheck(id);
      toast(`${STATUS[r.status]?.label || r.status}${r.reason ? `：${r.reason}` : ""}`);
      changed();
    } catch (e) {
      toastError(e);
    }
  };
  const [rescuing, setRescuing] = useState(false);
  const rescue = async () => {
    setRescuing(true);
    try {
      const r = await api.waybackRescue(id);
      toast(`已从 Internet Archive 找回一份副本 · ${r.title}`);
      setSnapshotId(0);
      changed();
    } catch (e) {
      toastError(e);
    } finally {
      setRescuing(false);
    }
  };
  const remove = async () => {
    if (!window.confirm("删除这份存档？本地文件会一起删除，无法恢复。")) return;
    await api.deleteArchive(id).catch(toastError);
    qc.invalidateQueries({ queryKey: ["archives"] });
    qc.invalidateQueries({ queryKey: keys.bootstrap });
    navigate("/archive");
  };

  return (
    <Layout mode="wide" view="reader">
      <main className="pane reader-pane">
        <div className="reader-bar scrolled">
          <Link href="/archive" className="icon-btn" aria-label="返回藏">
            <ArrowLeft size={20} />
          </Link>
          <div className="src" style={{ opacity: 1 }}>
            <Seal size="xs" />
            <span>{a?.title}</span>
          </div>
          <span className="spacer" />
          {a?.entryId && (
            <Link href={`/entry/${a.entryId}`} className="btn sm ghost">
              订阅原文
            </Link>
          )}
          <button className="icon-btn" onClick={tldr.toggle} aria-pressed={!!tldr.data && tldr.open} title="要点（I）" aria-label="要点">
            {tldr.busy ? <span className="spinner" /> : <Sparkles size={18} />}
          </button>
          <button className="icon-btn" onClick={tr.toggle} aria-pressed={tr.on} title="翻译（T）" aria-label="翻译">
            {tr.pending ? <span className="spinner" /> : <Languages size={18} />}
          </button>
          <button ref={prefsMenu.ref} className="icon-btn" onClick={prefsMenu.toggle} aria-label="阅读设置">
            <Type size={18} />
          </button>
          {snap && (
            <a className="icon-btn" href={snap.files.article} target="_blank" rel="noopener" title="打开离线阅读页">
              <FileText size={18} />
            </a>
          )}
          <button ref={more.ref} className="icon-btn" onClick={more.toggle} aria-label="更多">
            <MoreHorizontal size={19} />
          </button>
        </div>
        <div className="reader-scroll scroll">
          {q.isLoading ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : !a ? (
            <Empty art="vault" title="找不到这份存档" />
          ) : (
            <div className="archive-layout">
              <div className="article-wrap" style={readerStyle(prefs)}>
                {a.sourceStatus === "gone" && (
                  <div className="reader-banner lost">
                    <Seal size="sm" />
                    <span>
                      原文已经消失（{fullDate(a.goneAt)} 发现）。
                      {snap?.method === "wayback" ? "这是从 Internet Archive 找回的副本。" : `这是你在 ${fullDate(snap?.capturedAt)} 藏下的副本。`}
                    </span>
                    {snap?.method !== "wayback" && (
                      <button className="btn sm act" onClick={rescue} disabled={rescuing} title="去 Wayback Machine 找一份当年的副本">
                        {rescuing ? <span className="spinner" /> : <LifeBuoy size={14} />}
                        找 Internet Archive 的副本
                      </button>
                    )}
                  </div>
                )}
                {snap && a.snapshots[0] && snap.id !== a.snapshots[0].id && (
                  <div className="reader-banner">
                    <span>正在看 {fullDate(snap.capturedAt)} 的旧版本</span>
                    <button className="btn sm act" onClick={() => setSnapshotId(0)}>
                      回到最新
                    </button>
                  </div>
                )}
                <header className="article-head">
                  <div className="kicker">
                    <span>{a.site || hostname(a.url)}</span>
                  </div>
                  <h1 className={tr.title && tr.display === "only" ? "tr-replaced" : undefined}>{a.title}</h1>
                  {tr.on && tr.title && (
                    <div className="tr-title" lang={tr.lang}>
                      {tr.title}
                    </div>
                  )}
                  <div className="byline">
                    {a.author && (
                      <>
                        <span>{a.author}</span>
                        <span className="sep" />
                      </>
                    )}
                    {a.publishedAt && (
                      <>
                        <span>{fullDate(a.publishedAt)}</span>
                        <span className="sep" />
                      </>
                    )}
                    <span>藏于 {fullDate(snap?.capturedAt || a.createdAt)}</span>
                  </div>
                  <Seal />
                  <div className="rule" />
                </header>
                <SummaryCard s={tldr} />
                <TranslateStatus tr={tr} cfg={trCfg} />
                <ArticleView ref={article} html={a.content} highlights={a.highlights} target={{ archiveId: a.id }} prefs={prefs} translation={tr.shown} onChanged={changed} />
                {mobile && <Aside a={a} snapshotId={snap?.id || 0} onSnapshot={setSnapshotId} onChanged={changed} />}
              </div>
              {!mobile && <Aside a={a} snapshotId={snap?.id || 0} onSnapshot={setSnapshotId} onChanged={changed} />}
            </div>
          )}
        </div>
        {prefsMenu.open && (
          <Popover anchor={prefsMenu.el} onClose={prefsMenu.close}>
            <ReaderPrefsPanel />
          </Popover>
        )}
        {more.open && a && (
          <Popover anchor={more.el} onClose={more.close}>
            <Menu
              onClose={more.close}
              items={[
                { label: "检查原文是否还在", icon: <RefreshCcw size={15} />, onSelect: recheck },
                { label: "重新入藏一个新版本", icon: <RotateCw size={15} />, onSelect: () => recapture("fetch") },
                ...(boot.data?.egoBrowser ? [{ label: "用我的浏览器重新入藏", icon: <Globe size={15} />, onSelect: () => recapture("browser") }] : []),
                { label: "找 Internet Archive 的副本", icon: <LifeBuoy size={15} />, onSelect: rescue },
                { label: "打开原文", icon: <ExternalLink size={15} />, onSelect: () => window.open(a.url, "_blank", "noopener,noreferrer") },
                "sep",
                { label: "删除存档", icon: <Trash2 size={15} />, danger: true, onSelect: remove },
              ]}
            />
          </Popover>
        )}
      </main>
    </Layout>
  );
}
