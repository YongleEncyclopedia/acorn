import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { BookOpen, Bookmark, ChevronRight, Highlighter, Inbox, Layers, Plus, RefreshCw, Rss, Search, Settings, Sun, UserRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "../components/Logo.tsx";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Seal } from "../components/Seal.tsx";
import { useBootstrap, keys } from "../lib/queries.ts";
import { api } from "../lib/api.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { useCompact } from "../lib/useMedia.ts";
import type { EntryView, Feed } from "../../../src/shared/types.ts";

export type Stream = { kind: "view"; view: EntryView } | { kind: "feed"; id: number } | { kind: "folder"; id: number };

export function streamPath(s: Stream, entryId?: number | null): string {
  const base = s.kind === "view" ? `/s/${s.view}` : s.kind === "feed" ? `/feed/${s.id}` : `/folder/${s.id}`;
  return entryId ? `${base}/${entryId}` : base;
}

export const VIEW_TITLES: Record<EntryView, string> = {
  today: "今日",
  unread: "未读",
  starred: "稍后读",
  progress: "在读",
  all: "全部文章",
  archived: "已入藏的文章",
};

function useFolderOpen(): [Record<number, boolean>, (id: number) => void] {
  const [state, setState] = useState<Record<number, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("acorn.folders") || "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: number) =>
    setState((s) => {
      const next = { ...s, [id]: !(s[id] ?? true) };
      try {
        localStorage.setItem("acorn.folders", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  return [state, toggle];
}

function Item({ href, icon, label, count, alert, className = "", active }: { href: string; icon: ReactNode; label: string; count?: number; alert?: boolean; className?: string; active: boolean }) {
  return (
    <Link href={href} className={`side-item ${className}`} aria-current={active ? "page" : undefined}>
      <span className="ico">{icon}</span>
      <span className="label">{label}</span>
      {!!count && <span className={`count ${alert ? "alert" : ""}`}>{count > 999 ? "999+" : count}</span>}
    </Link>
  );
}

export function Sidebar() {
  const { data } = useBootstrap();
  const [loc] = useLocation();
  const qc = useQueryClient();
  const [open, toggle] = useFolderOpen();
  const feedsByFolder = useMemo(() => {
    const m = new Map<number | null, Feed[]>();
    for (const f of data?.feeds || []) {
      const k = f.folderId ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return m;
  }, [data?.feeds]);
  if (!data) return <aside className="sidebar" />;
  const c = data.counts;
  const is = (p: string) => loc === p || loc.startsWith(`${p}/`);
  const refreshAll = async () => {
    try {
      const r = await api.refreshAll();
      toast(r.queued ? `正在刷新 ${r.queued} 个订阅源` : "订阅源都在刷新中");
      window.setTimeout(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), 4000);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <aside className="sidebar" aria-label="导航">
      <div className="side-brand">
        <Logo size={24} />
        <span className="wordmark">松果</span>
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => ui.set({ palette: true })} title="搜索（⌘K）" aria-label="搜索">
          <Search size={17} />
        </button>
        <button className="icon-btn sm" onClick={() => ui.set({ addSource: {} })} title="添加订阅" aria-label="添加订阅">
          <Plus size={18} />
        </button>
      </div>
      <nav className="side-scroll scroll">
        <div className="side-section">
          <Item href="/s/today" icon={<Sun size={17} />} label="今日" count={c.today} active={is("/s/today")} />
          <Item href="/s/unread" icon={<Inbox size={17} />} label="未读" count={c.unread} active={is("/s/unread")} />
          <Item href="/s/starred" icon={<Bookmark size={17} />} label="稍后读" count={c.starred} active={is("/s/starred")} />
          <Item href="/s/progress" icon={<BookOpen size={17} />} label="在读" count={c.inProgress} active={is("/s/progress")} />
          <Item href="/s/all" icon={<Layers size={17} />} label="全部文章" active={is("/s/all")} />
        </div>
        <div className="side-section">
          <div className="side-label">收藏</div>
          <Item href="/archive" icon={<Seal size="xs" />} label="藏" count={c.archived} active={is("/archive")} />
          {c.gone > 0 && <Item href="/archive?status=gone" icon={<span style={{ width: 7, height: 7, borderRadius: 9, background: "var(--seal)" }} />} label="原文已消失" count={c.gone} alert active={false} />}
          <Item href="/notes" icon={<Highlighter size={17} />} label="批注" count={c.highlights} active={is("/notes")} />
        </div>
        <div className="side-section">
          <div className="side-label">
            订阅
            <button className="icon-btn sm" onClick={refreshAll} title="全部刷新" aria-label="全部刷新">
              <RefreshCw size={14} />
            </button>
          </div>
          {data.folders.map((folder) => {
            const feeds = feedsByFolder.get(folder.id) || [];
            if (!feeds.length) return null;
            const unread = feeds.reduce((n, f) => n + f.unread, 0);
            const isOpen = open[folder.id] ?? true;
            return (
              <div key={folder.id}>
                <div className="side-item" aria-current={is(`/folder/${folder.id}`) ? "page" : undefined} style={{ paddingLeft: 8 }}>
                  <button className="folder-toggle" data-open={isOpen} onClick={() => toggle(folder.id)} aria-label={isOpen ? "收起" : "展开"}>
                    <ChevronRight size={14} />
                  </button>
                  <Link href={`/folder/${folder.id}`} className="label" style={{ fontWeight: 600 }}>
                    {folder.name}
                  </Link>
                  {!!unread && <span className="count">{unread}</span>}
                </div>
                {isOpen &&
                  feeds.map((f) => (
                    <Link key={f.id} href={`/feed/${f.id}`} className="side-item feed nested" aria-current={is(`/feed/${f.id}`) ? "page" : undefined} title={f.lastError ? `抓取失败：${f.lastError}` : f.title}>
                      <FeedIcon feed={f} />
                      <span className="label">{f.title}</span>
                      {f.errorCount > 0 && <span className="err" />}
                      {!!f.unread && <span className="count">{f.unread}</span>}
                    </Link>
                  ))}
              </div>
            );
          })}
          {(feedsByFolder.get(null) || []).map((f) => (
            <Link key={f.id} href={`/feed/${f.id}`} className="side-item feed" aria-current={is(`/feed/${f.id}`) ? "page" : undefined} title={f.lastError ? `抓取失败：${f.lastError}` : f.title}>
              <FeedIcon feed={f} />
              <span className="label">{f.title}</span>
              {f.errorCount > 0 && <span className="err" />}
              {!!f.unread && <span className="count">{f.unread}</span>}
            </Link>
          ))}
          {!data.feeds.length && (
            <button className="side-item" onClick={() => ui.set({ addSource: {} })}>
              <span className="ico">
                <Plus size={16} />
              </span>
              <span className="label">添加第一个订阅</span>
            </button>
          )}
        </div>
      </nav>
      <div className="side-foot">
        <Link href="/sources" className="side-item" aria-current={is("/sources") ? "page" : undefined} title="订阅管理">
          <Rss size={17} />
        </Link>
        <Link href="/settings" className="side-item" aria-current={is("/settings") ? "page" : undefined} title="设置">
          <Settings size={17} />
        </Link>
      </div>
    </aside>
  );
}

function TabBar() {
  const [loc] = useLocation();
  const { data } = useBootstrap();
  const is = (...p: string[]) => p.some((x) => loc === x || loc.startsWith(`${x}/`));
  return (
    <nav className="tabbar" aria-label="主导航">
      <Link href="/s/today" aria-current={is("/s", "/feed", "/folder", "/entry") ? "page" : undefined}>
        <Sun size={22} />
        阅读
        {!!data?.counts.today && <span className="dot">{data.counts.today > 99 ? "99+" : data.counts.today}</span>}
      </Link>
      <Link href="/archive" aria-current={is("/archive") ? "page" : undefined}>
        <Seal size="xs" />
        藏
      </Link>
      <Link href="/notes" aria-current={is("/notes") ? "page" : undefined}>
        <Highlighter size={22} />
        批注
      </Link>
      <Link href="/search" aria-current={is("/search") ? "page" : undefined}>
        <Search size={22} />
        搜索
      </Link>
      <Link href="/settings" aria-current={is("/settings", "/sources") ? "page" : undefined}>
        <UserRound size={22} />
        我的
      </Link>
    </nav>
  );
}

export function Layout({ mode, view, children }: { mode: "three" | "wide"; view?: "list" | "reader"; children: ReactNode }) {
  const drawer = ui.use((s) => s.drawer);
  const compact = useCompact();
  const [loc] = useLocation();
  useEffect(() => {
    ui.set({ drawer: false });
  }, [loc]);
  return (
    <>
      <div className="shell" data-mode={mode === "wide" ? "wide" : undefined} data-view={view} data-drawer={drawer ? "open" : undefined}>
        <Sidebar />
        {children}
      </div>
      {drawer && compact && <div className="drawer-scrim" onClick={() => ui.set({ drawer: false })} />}
      <TabBar />
    </>
  );
}
