import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Bookmark, FileText, Folder as FolderIcon, Highlighter, Inbox, Keyboard, Link2, Menu as MenuIcon, Moon, PanelLeftClose, Plus, RefreshCw, Rss, Search as SearchIcon, Settings, Sun, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Layout } from "./Layout.tsx";
import { api } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { useBootstrap } from "../lib/queries.ts";
import { useDocumentTitle, useFocusMode } from "../lib/shell.ts";
import { useLayer } from "../lib/layers.ts";
import { Seal } from "../components/Seal.tsx";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Empty } from "../components/Empty.tsx";
import { usePrefs } from "./ReaderPrefs.tsx";
import { resolveTheme } from "../lib/theme.ts";

function useSearchResults(q: string) {
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);
  return useQuery({ queryKey: ["search", debounced], queryFn: () => api.search(debounced), enabled: debounced.length > 0, staleTime: 30_000, placeholderData: (p) => p });
}

function Mark({ text, q }: { text: string; q: string }) {
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

interface Row {
  key: string;
  group: string;
  icon: React.ReactNode;
  title: string;
  sub?: string;
  /** The key that does the same thing without the palette. */
  hint?: string;
  /** Extra words a command can be found by. */
  words?: string;
  run: () => void;
}

function useRows(q: string, close: () => void, more = false): Row[] {
  const [, navigate] = useLocation();
  const res = useSearchResults(q);
  const boot = useBootstrap();
  const [prefs, setPrefs] = usePrefs();
  const [focus, toggleFocus] = useFocusMode();
  const feeds = boot.data?.feeds;
  const folders = boot.data?.folders;
  return useMemo(() => {
    const go = (p: string) => {
      close();
      navigate(p);
    };
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    const dark = resolveTheme(prefs.theme) === "night" || resolveTheme(prefs.theme) === "ink";
    const actions: Row[] = [
      { key: "c-add", group: "操作", icon: <Plus size={16} />, title: "添加订阅", words: "add subscribe rss 新增", run: act(() => ui.set({ addSource: {} })) },
      { key: "c-capture", group: "操作", icon: <Link2 size={16} />, title: "入藏一个网址", words: "capture archive save 保存 收藏", run: () => go("/archive?capture=1") },
      { key: "c-theme", group: "操作", icon: <Moon size={16} />, title: dark ? "切换到纸色主题" : "切换到夜间主题", words: "theme dark light 深色 浅色 主题", run: act(() => setPrefs({ theme: dark ? "paper" : "night" })) },
      { key: "c-focus", group: "操作", icon: <PanelLeftClose size={16} />, title: focus ? "退出专注阅读" : "专注阅读", hint: "Z", words: "focus zen 专注 侧栏", run: act(toggleFocus) },
      {
        key: "c-refresh",
        group: "操作",
        icon: <RefreshCw size={16} />,
        title: "刷新全部订阅源",
        words: "refresh update 更新",
        run: act(() => void api.refreshAll().then((r) => toast(r.queued ? `正在刷新 ${r.queued} 个订阅源` : "订阅源都在刷新中"), toastError)),
      },
      { key: "c-keys", group: "操作", icon: <Keyboard size={16} />, title: "键盘快捷键", hint: "?", words: "shortcuts keyboard help 帮助", run: act(() => ui.set({ shortcuts: true })) },
    ];
    const places: Row[] = [
      { key: "g-today", group: "前往", icon: <Sun size={16} />, title: "今日", hint: "G T", words: "today", run: () => go("/s/today") },
      { key: "g-unread", group: "前往", icon: <Inbox size={16} />, title: "未读", hint: "G U", words: "unread inbox", run: () => go("/s/unread") },
      { key: "g-later", group: "前往", icon: <Bookmark size={16} />, title: "稍后读", hint: "G S", words: "starred later", run: () => go("/s/starred") },
      { key: "g-reading", group: "前往", icon: <BookOpen size={16} />, title: "在读", words: "reading progress", run: () => go("/s/progress") },
      { key: "g-archive", group: "前往", icon: <Seal size="xs" />, title: "藏", hint: "G A", words: "archive 存档", run: () => go("/archive") },
      { key: "g-notes", group: "前往", icon: <Highlighter size={16} />, title: "批注", hint: "G N", words: "notes highlights 笔记 高亮", run: () => go("/notes") },
      { key: "g-sources", group: "前往", icon: <Rss size={16} />, title: "订阅管理", words: "sources feeds 订阅源", run: () => go("/sources") },
      { key: "g-settings", group: "前往", icon: <Settings size={16} />, title: "设置", words: "settings preferences 偏好", run: () => go("/settings") },
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return [...actions.filter((a) => a.key !== "c-refresh"), ...places.slice(0, 6)];
    const has = (...texts: (string | undefined | null)[]) => texts.some((t) => t?.toLowerCase().includes(needle));
    // Typing a feed's name is the quickest way to it; commands come next, then what the library contains.
    const sources: Row[] = [
      ...(folders || []).filter((f) => has(f.name)).map((f) => ({ key: `fo${f.id}`, group: "订阅源", icon: <FolderIcon size={16} />, title: f.name, sub: "分组", run: () => go(`/folder/${f.id}`) })),
      ...(feeds || [])
        .filter((f) => has(f.title, f.siteUrl, f.url))
        .map((f) => ({ key: `fe${f.id}`, group: "订阅源", icon: <FeedIcon feed={f} />, title: f.title, sub: f.unread ? `${f.unread} 篇未读` : undefined, run: () => go(`/feed/${f.id}`) })),
    ].slice(0, more ? 20 : 6);
    const commands = [...places, ...actions].filter((r) => has(r.title, r.words)).map((r) => ({ ...r, group: "操作" }));
    const d = res.data;
    return [
      ...sources,
      ...commands,
      ...(d?.entries || []).slice(0, more ? 40 : 8).map((e) => ({ key: `e${e.id}`, group: "文章", icon: <FileText size={16} />, title: e.title, sub: [relTime(e.publishedAt || e.createdAt), e.summary].filter(Boolean).join(" · "), run: () => go(`/entry/${e.id}`) })),
      ...(d?.archives || []).slice(0, more ? 30 : 6).map((a) => ({ key: `a${a.id}`, group: "藏", icon: <Seal size="xs" />, title: a.title, sub: [a.site, a.excerpt].filter(Boolean).join(" · "), run: () => go(`/archive/${a.id}`) })),
      ...(d?.highlights || []).slice(0, more ? 30 : 6).map((h) => ({ key: `h${h.id}`, group: "批注", icon: <Highlighter size={16} />, title: h.quote, sub: [h.title, h.note].filter(Boolean).join(" · "), run: () => go(h.archiveId ? `/archive/${h.archiveId}` : `/entry/${h.entryId}`) })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, res.data, prefs.theme, focus, feeds, folders, close, navigate, setPrefs, more]);
}

function Results({ q, rows, active, setActive }: { q: string; rows: Row[]; active: number; setActive: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Arrow keys can move the selection past the edge of the list.
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  let lastGroup = "";
  return (
    <div ref={ref} role="listbox" aria-label="结果">
      {rows.map((r, i) => {
        const head = r.group !== lastGroup ? <div className="palette-group">{r.group}</div> : null;
        lastGroup = r.group;
        return (
          <div key={r.key}>
            {head}
            <button className="palette-item" role="option" aria-selected={i === active} onMouseMove={() => i !== active && setActive(i)} onClick={r.run}>
              <span className="ico">{r.icon}</span>
              <span className="body">
                <div className="t">
                  <Mark text={r.title} q={q} />
                </div>
                {r.sub && (
                  <div className="s">
                    <Mark text={r.sub} q={q} />
                  </div>
                )}
              </span>
              {r.hint && <kbd>{r.hint}</kbd>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SearchPalette() {
  const open = ui.use((s) => s.palette);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const close = useMemo(() => () => ui.set({ palette: false }), []);
  const rows = useRows(q, close);
  const searching = useSearchResults(q).isFetching;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      window.setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useLayer(close, open);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="搜索">
        <div className="palette-input">
          <SearchIcon size={18} color="var(--ink-3)" />
          <input
            ref={input}
            autoFocus
            placeholder="搜索文章、存档、批注，或输入订阅源的名字…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              if (e.key === "Enter" && !e.nativeEvent.isComposing) rows[active]?.run();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results scroll">
          {rows.length ? <Results q={q} rows={rows} active={active} setActive={setActive} /> : q.trim() ? <div className="menu-note" style={{ padding: 16 }}>{searching ? "正在搜索…" : `没有找到「${q}」`}</div> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const noop = () => undefined;

export function SearchPage() {
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") || "");
  const [active, setActive] = useState(0);
  const rows = useRows(q, noop, true);
  useEffect(() => setActive(0), [q]);
  useDocumentTitle(q.trim() ? `搜索「${q.trim()}」` : "搜索");
  // Keep the query in the address bar, so a search can be bookmarked or linked to (e.g. from the CLI).
  useEffect(() => {
    window.history.replaceState(window.history.state, "", q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : "/search");
  }, [q]);
  return (
    <Layout mode="wide">
      <main className="pane wide-pane scroll">
        <header className="pane-head wide-head">
          <button className="icon-btn menu-btn" onClick={() => ui.set({ drawer: true })} aria-label="打开导航">
            <MenuIcon size={20} />
          </button>
        </header>
        <div className="page narrow search-page">
          <label className="search-hero">
            <SearchIcon size={19} />
            <input
              autoFocus
              type="search"
              enterKeyHint="search"
              placeholder="搜索文章、存档、批注…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)));
                if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
                if (e.key === "Enter" && !e.nativeEvent.isComposing) rows[active]?.run();
              }}
            />
            {!!q && (
              <button className="icon-btn sm" aria-label="清空" onClick={() => setQ("")}>
                <X size={15} />
              </button>
            )}
          </label>
          {rows.length ? <Results q={q} rows={rows} active={active} setActive={setActive} /> : q.trim() ? <Empty art="search" title={`没有找到「${q}」`} /> : null}
        </div>
      </main>
    </Layout>
  );
}
