import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Highlighter,
  Languages,
  MoreHorizontal,
  RotateCw,
  Settings2,
  Share2,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { api } from "../lib/api.ts";
import { keys, useBootstrap, useEntry, useEntryActions } from "../lib/queries.ts";
import { fullDate, hostname, readingTime } from "../lib/format.ts";
import { readerStyle } from "../lib/theme.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { useMobile } from "../lib/useMedia.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { Popover, Menu, useAnchor, type MenuItem } from "../components/Popover.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty } from "../components/Empty.tsx";
import { ArticleView, type ArticleHandle } from "./ArticleView.tsx";
import { TranslateStatus } from "../components/TranslateStatus.tsx";
import { SummaryCard, useSummary } from "../components/SummaryCard.tsx";
import { useReaderTranslation } from "../lib/translate.ts";
import { ReaderPrefsPanel, usePrefs } from "./ReaderPrefs.tsx";
import type { Entry, EntrySummary, Highlight } from "../../../src/shared/types.ts";

/** Scroll metrics for either the reader pane (desktop) or the window (mobile). */
function useScroll(container: React.RefObject<HTMLElement | null>, mobile: boolean, onScroll: (p: number, dir: number) => void, deps: unknown[]) {
  useEffect(() => {
    const target: HTMLElement | Window = mobile ? window : container.current!;
    if (!target) return;
    let last = 0;
    const metrics = () => {
      if (mobile) {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        return { y: window.scrollY, p: h > 0 ? window.scrollY / h : 1 };
      }
      const el = container.current!;
      const h = el.scrollHeight - el.clientHeight;
      return { y: el.scrollTop, p: h > 0 ? el.scrollTop / h : 1 };
    };
    const handler = () => {
      const m = metrics();
      onScroll(Math.max(0, Math.min(1, m.p)), Math.sign(m.y - last));
      last = m.y;
    };
    target.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => target.removeEventListener("scroll", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, ...deps]);
}

function scrollToProgress(container: HTMLElement | null, mobile: boolean, p: number) {
  if (mobile) {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: h * p });
  } else if (container) {
    container.scrollTop = (container.scrollHeight - container.clientHeight) * p;
  }
}

export function EntryReader({ id, next, onBack, onNext }: { id: number; next: EntrySummary | null; onBack: () => void; onNext: () => void }) {
  const { data: entry, isLoading, error, refetch } = useEntry(id);
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const mobile = useMobile();
  const [prefs] = usePrefs();
  const { setRead, setStar, setProgress } = useEntryActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const article = useRef<ArticleHandle>(null);
  const [progress, setProg] = useState(0);
  const [barHidden, setBarHidden] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const notesOpen = ui.use((s) => s.notesPanel);
  const prefsMenu = useAnchor();
  const sealMenu = useAnchor();
  const moreMenu = useAnchor();
  const restored = useRef<number | null>(null);
  const lastSaved = useRef(0);
  const saveTimer = useRef(0);
  const prevArchive = useRef<number | null | undefined>(undefined);
  const [stampNow, setStampNow] = useState(false);
  const feed = boot.data?.feeds.find((f) => f.id === entry?.feedId);
  const html = entry ? (showFeed && entry.hasFullContent ? entry.feedContent : entry.content) : "";
  const trCfg = boot.data?.settings.translate;
  const tr = useReaderTranslation(article, { id: `entry:${id}`, html, title: entry?.title || "", cfg: trCfg });
  const tldr = useSummary({ entryId: id }, `${id}:${html.length}`, !!html);

  // reset per entry
  useEffect(() => {
    setShowFeed(false);
    setProg(0);
    restored.current = null;
    lastSaved.current = 0;
    prevArchive.current = undefined;
    setStampNow(false);
    if (!mobile && scrollRef.current) scrollRef.current.scrollTop = 0;
    if (mobile) window.scrollTo(0, 0);
  }, [id, mobile]);

  // mark as read on open
  useEffect(() => {
    if (!entry || entry.id !== id) return;
    if (!entry.readAt && boot.data?.settings.markReadOnOpen) {
      const t = window.setTimeout(() => setRead.mutate({ entry, read: true }), 350);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);

  // stamp animation when an archive appears while reading
  useEffect(() => {
    if (!entry) return;
    if (prevArchive.current === null && entry.archiveId) setStampNow(true);
    prevArchive.current = entry.archiveId;
  }, [entry?.archiveId, entry]);

  // restore reading position once content is in
  useEffect(() => {
    if (!entry || restored.current === entry.id) return;
    restored.current = entry.id;
    if (entry.progress > 0.03 && entry.progress < 0.97) {
      window.setTimeout(() => scrollToProgress(scrollRef.current, mobile, entry.progress), 120);
    }
  }, [entry, mobile]);

  useScroll(
    scrollRef,
    mobile,
    (p, dir) => {
      setProg(p);
      if (dir > 0 && p > 0.02) setBarHidden(true);
      else if (dir < 0) setBarHidden(false);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (entry && Math.abs(p - lastSaved.current) > 0.03 && restored.current === entry.id) {
          lastSaved.current = p;
          setProgress.mutate({ id: entry.id, progress: p });
        }
      }, 1200);
    },
    [entry?.id],
  );

  const refreshEntry = () => qc.invalidateQueries({ queryKey: keys.entry(id) });

  const loadFull = async () => {
    if (!entry) return;
    if (entry.hasFullContent) return setShowFeed((s) => !s);
    setLoadingFull(true);
    try {
      const r = await api.fulltext(entry.id);
      if (!r.ok) toast(`没能获取全文：${r.error}`, { kind: "error" });
      qc.setQueryData(keys.entry(entry.id), r.entry);
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingFull(false);
    }
  };

  const capture = async (method: "fetch" | "browser") => {
    if (!entry) return;
    try {
      if (entry.archive) await api.snapshot(entry.archive.id, method);
      else await api.capture({ entryId: entry.id, method });
      toast(method === "browser" ? "正在用你的浏览器打开原文入藏…" : "正在入藏…");
    } catch (e) {
      toastError(e);
    }
  };

  const toggleStar = () => entry && setStar.mutate({ entry, starred: !entry.starredAt });
  const openOriginal = () => entry?.url && window.open(entry.url, "_blank", "noopener,noreferrer");

  useHotkeys(
    {
      s: toggleStar,
      m: () => entry && setRead.mutate({ entry, read: !entry.readAt }),
      v: openOriginal,
      a: () => capture("fetch"),
      f: loadFull,
      h: () => ui.set((s) => ({ notesPanel: !s.notesPanel })),
      t: tr.toggle,
      i: tldr.toggle,
      Escape: () => (notesOpen ? ui.set({ notesPanel: false }) : onBack()),
    },
    !!entry,
  );

  if (isLoading) {
    return (
      <div className="article-wrap" style={readerStyle(prefs)}>
        <div className="article-head">
          <div className="skeleton" style={{ height: 14, width: 120, marginBottom: 18 }} />
          <div className="skeleton" style={{ height: 34, width: "86%", marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 34, width: "60%" }} />
        </div>
        <div className="article">
          {[92, 100, 96, 70, 100, 88].map((w, i) => (
            <div key={i} className="skeleton" style={{ height: 16, width: `${w}%`, marginBottom: 14 }} />
          ))}
        </div>
      </div>
    );
  }
  if (error || !entry) return <Empty art="search" title="找不到这篇文章" />;

  const archived = !!entry.archive;
  const gone = entry.archive?.sourceStatus === "gone";
  const ego = boot.data?.egoBrowser;

  const sealItems: (MenuItem | "sep")[] = [
    ...(archived ? [{ label: "查看存档", icon: <Seal size="xs" />, onSelect: () => navigate(`/archive/${entry.archive!.id}`) }, "sep" as const] : []),
    { label: archived ? "重新入藏一份新版本" : "入藏到本地", icon: <RotateCw size={15} />, hint: archived ? undefined : "A", onSelect: () => capture("fetch") },
    ...(ego ? [{ label: "用我的浏览器入藏", icon: <Globe size={15} />, onSelect: () => capture("browser") }] : []),
  ];
  const moreItems: (MenuItem | "sep")[] = [
    { label: entry.readAt ? "标为未读" : "标为已读", icon: <CircleDot size={15} />, hint: "M", onSelect: () => setRead.mutate({ entry, read: !entry.readAt }) },
    { label: "复制链接", icon: <Copy size={15} />, onSelect: () => navigator.clipboard?.writeText(entry.url || "").then(() => toast("已复制链接")) },
    ...(typeof navigator.share === "function" && entry.url ? [{ label: "分享…", icon: <Share2 size={15} />, onSelect: () => navigator.share({ title: entry.title, url: entry.url! }).catch(() => undefined) }] : []),
    "sep",
    { label: "订阅源设置", icon: <Settings2 size={15} />, onSelect: () => navigate(`/sources?edit=${entry.feedId}`) },
  ];

  const highlights: Highlight[] = entry.highlights;

  return (
    <>
      <div className={`reader-bar ${progress > 0.004 ? "scrolled" : ""} ${barHidden && mobile ? "hidden" : ""}`}>
        <button className="icon-btn back" onClick={onBack} aria-label="返回">
          <ArrowLeft size={20} />
        </button>
        <div className="src">
          <span>{feed?.title}</span>
        </div>
        <span className="spacer" />
        {!mobile && (
          <>
            <button className="icon-btn" aria-pressed={!!entry.starredAt} onClick={toggleStar} title="稍后读（S）" aria-label="稍后读">
              {entry.starredAt ? <BookmarkCheck size={19} /> : <Bookmark size={19} />}
            </button>
            <button ref={sealMenu.ref} className="icon-btn" onClick={sealMenu.toggle} title="入藏（A）" aria-label="入藏">
              <Seal size="xs" muted={!archived} />
            </button>
            <button className="icon-btn" onClick={loadFull} aria-pressed={entry.hasFullContent && !showFeed} title={entry.hasFullContent ? (showFeed ? "显示全文（F）" : "显示订阅源原始内容（F）") : "抓取全文（F）"} aria-label="全文">
              {loadingFull ? <span className="spinner" /> : <FileText size={18} />}
            </button>
            <button className="icon-btn" onClick={() => ui.set((s) => ({ notesPanel: !s.notesPanel }))} aria-pressed={notesOpen} title="批注（H）" aria-label="批注">
              <Highlighter size={18} />
            </button>
            <button className="icon-btn" onClick={tldr.toggle} aria-pressed={!!tldr.data && tldr.open} title="要点（I）" aria-label="要点">
              {tldr.busy ? <span className="spinner" /> : <Sparkles size={18} />}
            </button>
            <button className="icon-btn" onClick={tr.toggle} aria-pressed={tr.on} title="翻译（T）" aria-label="翻译">
              {tr.pending ? <span className="spinner" /> : <Languages size={18} />}
            </button>
            <button ref={prefsMenu.ref} className="icon-btn" onClick={prefsMenu.toggle} title="阅读设置" aria-label="阅读设置">
              <Type size={18} />
            </button>
            <button className="icon-btn" onClick={openOriginal} disabled={!entry.url} title="打开原文（V）" aria-label="打开原文">
              <ExternalLink size={18} />
            </button>
          </>
        )}
        <button ref={moreMenu.ref} className="icon-btn" onClick={moreMenu.toggle} aria-label="更多">
          <MoreHorizontal size={19} />
        </button>
        <div className="read-progress" style={{ width: `${progress * 100}%` }} />
      </div>

      <div ref={scrollRef} className="reader-scroll scroll">
        <div className="article-wrap" style={readerStyle(prefs)}>
          {gone && (
            <div className="reader-banner lost">
              <Seal size="sm" />
              <span>原文已经消失。你正在读的内容来自 {fullDate(entry.archive?.latestCapturedAt)} 的本地存档。</span>
            </div>
          )}
          {!entry.hasFullContent && entry.fullError && !gone && (
            <div className="reader-banner">
              <span>没能抓到全文：{entry.fullError}</span>
              <button className="btn sm act" onClick={loadFull}>
                重试
              </button>
            </div>
          )}
          <header className="article-head">
            <div className="kicker">
              <Link href={`/feed/${entry.feedId}`}>{feed?.title || "订阅源"}</Link>
              {entry.starredAt && <Bookmark size={13} fill="currentColor" />}
            </div>
            <h1 className={tr.title && tr.display === "only" ? "tr-replaced" : undefined}>{entry.title}</h1>
            {tr.on && tr.title && (
              <div className="tr-title" lang={tr.lang}>
                {tr.title}
              </div>
            )}
            <div className="byline">
              {entry.author && <span>{entry.author}</span>}
              {entry.author && <span className="sep" />}
              <span>{fullDate(entry.publishedAt || entry.createdAt)}</span>
              {!!entry.wordCount && (
                <>
                  <span className="sep" />
                  <span>
                    {entry.wordCount.toLocaleString("zh-CN")} 字 · {readingTime(entry.wordCount)}
                  </span>
                </>
              )}
              {entry.url && (
                <>
                  <span className="sep" />
                  <a href={entry.url} target="_blank" rel="noopener noreferrer">
                    {hostname(entry.url)}
                  </a>
                </>
              )}
            </div>
            {archived && (
              <Link href={`/archive/${entry.archive!.id}`} title="已入藏，点击查看存档">
                <Seal stamp={stampNow} />
              </Link>
            )}
            <div className="rule" />
          </header>
          <SummaryCard s={tldr} />
          <TranslateStatus tr={tr} cfg={trCfg} />
          <ArticleView ref={article} html={html} highlights={highlights} target={{ entryId: entry.id }} prefs={prefs} translation={tr.shown} onChanged={refreshEntry} />
          <ArticleEnd entry={entry} next={next} onNext={onNext} onStar={toggleStar} onArchive={() => capture("fetch")} />
        </div>
      </div>

      {mobile && (
        <div className={`reader-dock ${barHidden ? "hidden" : ""}`}>
          <button className="icon-btn" aria-pressed={!!entry.starredAt} onClick={toggleStar} aria-label="稍后读">
            {entry.starredAt ? <BookmarkCheck size={21} /> : <Bookmark size={21} />}
          </button>
          <button ref={sealMenu.ref} className="icon-btn" onClick={sealMenu.toggle} aria-label="入藏">
            <Seal size="sm" muted={!archived} />
          </button>
          <button className="icon-btn" onClick={loadFull} aria-label="全文">
            {loadingFull ? <span className="spinner" /> : <FileText size={20} />}
          </button>
          <button className="icon-btn" onClick={() => ui.set((s) => ({ notesPanel: !s.notesPanel }))} aria-label="批注">
            <Highlighter size={20} />
          </button>
          <button className="icon-btn" onClick={tldr.toggle} aria-pressed={!!tldr.data && tldr.open} aria-label="要点">
            {tldr.busy ? <span className="spinner" /> : <Sparkles size={20} />}
          </button>
          <button className="icon-btn" onClick={tr.toggle} aria-pressed={tr.on} aria-label="翻译">
            {tr.pending ? <span className="spinner" /> : <Languages size={20} />}
          </button>
          <button ref={prefsMenu.ref} className="icon-btn" onClick={prefsMenu.toggle} aria-label="阅读设置">
            <Type size={20} />
          </button>
          <button className="icon-btn" onClick={openOriginal} aria-label="打开原文">
            <ExternalLink size={20} />
          </button>
        </div>
      )}

      {prefsMenu.open && (
        <Popover anchor={prefsMenu.el} onClose={prefsMenu.close} placement={mobile ? "top" : "bottom-end"}>
          <ReaderPrefsPanel />
        </Popover>
      )}
      {sealMenu.open && (
        <Popover anchor={sealMenu.el} onClose={sealMenu.close} placement={mobile ? "top" : "bottom-end"}>
          <Menu
            items={sealItems}
            onClose={sealMenu.close}
            note={ego ? "「用我的浏览器入藏」会在这台电脑上用你已登录的浏览器打开原文，适合公众号、小红书、知乎等有登录或验证的网站。" : "入藏会把正文和图片保存到本地硬盘，原文删除后依然可读。"}
          />
        </Popover>
      )}
      {moreMenu.open && (
        <Popover anchor={moreMenu.el} onClose={moreMenu.close}>
          <Menu items={moreItems} onClose={moreMenu.close} />
        </Popover>
      )}
      {notesOpen && <NotesPanel highlights={highlights} onPick={(hid) => article.current?.flash(hid)} />}
    </>
  );
}

function ArticleEnd({ entry, next, onNext, onStar, onArchive }: { entry: Entry; next: EntrySummary | null; onNext: () => void; onStar: () => void; onArchive: () => void }) {
  return (
    <div className="article-end">
      <div className="orn">· · ·</div>
      <div className="row">
        <button className="btn sm" onClick={onStar}>
          {entry.starredAt ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
          {entry.starredAt ? "已在稍后读" : "稍后读"}
        </button>
        {!entry.archive && (
          <button className="btn sm" onClick={onArchive}>
            <Seal size="xs" />
            入藏
          </button>
        )}
        {entry.url && (
          <a className="btn sm ghost" href={entry.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />
            原文
          </a>
        )}
      </div>
      {next && (
        <button className="next-card" onClick={onNext}>
          <div style={{ flex: 1 }}>
            <div className="k">下一篇 · J</div>
            <div className="t">{next.title}</div>
          </div>
          <Check size={18} style={{ opacity: 0 }} />
        </button>
      )}
    </div>
  );
}

function NotesPanel({ highlights, onPick }: { highlights: Highlight[]; onPick: (id: number) => void }) {
  return (
    <aside className="notes-panel" aria-label="本文批注">
      <div className="head">
        <Highlighter size={18} />
        <h2>本文批注 · {highlights.length}</h2>
        <button className="icon-btn sm" onClick={() => ui.set({ notesPanel: false })} aria-label="关闭">
          <X size={18} />
        </button>
      </div>
      <div className="list scroll">
        {highlights.length ? (
          highlights.map((h) => (
            <div key={h.id} className="item" style={{ borderLeftColor: `var(--hl-${h.color}-solid)` }} onClick={() => onPick(h.id)}>
              <q>{h.quote}</q>
              {h.note && <div className="n">{h.note}</div>}
            </div>
          ))
        ) : (
          <Empty art="notes" title="还没有批注">
            选中文字就能高亮、写下想法。批注过的文章会自动入藏。
          </Empty>
        )}
      </div>
    </aside>
  );
}
