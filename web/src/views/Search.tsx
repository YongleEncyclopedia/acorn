import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { FileText, Highlighter, Link2, Menu as MenuIcon, Moon, Plus, Search as SearchIcon, Settings } from "lucide-react";
import { createPortal } from "react-dom";
import { Layout } from "./Layout.tsx";
import { api } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { ui } from "../lib/store.ts";
import { Seal } from "../components/Seal.tsx";
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
  run: () => void;
}

function useRows(q: string, close: () => void): Row[] {
  const [, navigate] = useLocation();
  const res = useSearchResults(q);
  const [prefs, setPrefs] = usePrefs();
  return useMemo(() => {
    const go = (p: string) => {
      close();
      navigate(p);
    };
    if (!q.trim()) {
      const dark = resolveTheme(prefs.theme) === "night" || resolveTheme(prefs.theme) === "ink";
      return [
        { key: "a1", group: "快捷操作", icon: <Plus size={16} />, title: "添加订阅", run: () => (close(), ui.set({ addSource: {} })) },
        { key: "a2", group: "快捷操作", icon: <Link2 size={16} />, title: "入藏一个网址", run: () => go("/archive?capture=1") },
        { key: "a3", group: "快捷操作", icon: <Moon size={16} />, title: dark ? "切换到纸色主题" : "切换到夜间主题", run: () => (close(), setPrefs({ theme: dark ? "paper" : "night" })) },
        { key: "a4", group: "快捷操作", icon: <Settings size={16} />, title: "设置", run: () => go("/settings") },
      ];
    }
    const d = res.data;
    if (!d) return [];
    return [
      ...d.entries.slice(0, 8).map((e) => ({ key: `e${e.id}`, group: "文章", icon: <FileText size={16} />, title: e.title, sub: [relTime(e.publishedAt || e.createdAt), e.summary].filter(Boolean).join(" · "), run: () => go(`/entry/${e.id}`) })),
      ...d.archives.slice(0, 6).map((a) => ({ key: `a${a.id}`, group: "藏", icon: <Seal size="xs" />, title: a.title, sub: [a.site, a.excerpt].filter(Boolean).join(" · "), run: () => go(`/archive/${a.id}`) })),
      ...d.highlights.slice(0, 6).map((h) => ({ key: `h${h.id}`, group: "批注", icon: <Highlighter size={16} />, title: h.quote, sub: [h.title, h.note].filter(Boolean).join(" · "), run: () => go(h.archiveId ? `/archive/${h.archiveId}` : `/entry/${h.entryId}`) })),
    ];
  }, [q, res.data, prefs.theme, close, navigate, setPrefs]);
}

function Results({ q, rows, active, setActive }: { q: string; rows: Row[]; active: number; setActive: (i: number) => void }) {
  let lastGroup = "";
  return (
    <>
      {rows.map((r, i) => {
        const head = r.group !== lastGroup ? <div className="palette-group">{r.group}</div> : null;
        lastGroup = r.group;
        return (
          <div key={r.key}>
            {head}
            <button className="palette-item" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={r.run}>
              <span style={{ color: "var(--ink-3)", marginTop: 2 }}>{r.icon}</span>
              <span style={{ minWidth: 0 }}>
                <div className="t">
                  <Mark text={r.title} q={q} />
                </div>
                {r.sub && (
                  <div className="s">
                    <Mark text={r.sub} q={q} />
                  </div>
                )}
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
}

export function SearchPalette() {
  const open = ui.use((s) => s.palette);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const close = useMemo(() => () => ui.set({ palette: false }), []);
  const rows = useRows(q, close);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      window.setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => setActive(0), [rows.length]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="搜索">
        <div className="palette-input">
          <SearchIcon size={18} color="var(--ink-3)" />
          <input
            ref={input}
            autoFocus
            placeholder="搜索文章、存档、批注…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              if (e.key === "Enter" && !e.nativeEvent.isComposing) rows[active]?.run();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results scroll">
          {rows.length ? <Results q={q} rows={rows} active={active} setActive={setActive} /> : q.trim() ? <div className="menu-note" style={{ padding: 16 }}>没有找到「{q}」</div> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SearchPage() {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rows = useRows(q, () => undefined);
  return (
    <Layout mode="wide">
      <main className="pane wide-pane">
        <header className="pane-head">
          <button className="icon-btn menu-btn" onClick={() => ui.set({ drawer: true })} aria-label="打开导航">
            <MenuIcon size={20} />
          </button>
          <div className="search-field" style={{ maxWidth: "none" }}>
            <SearchIcon size={16} />
            <input className="field" autoFocus placeholder="搜索文章、存档、批注…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </header>
        <div className="page narrow" style={{ paddingTop: 8 }}>
          {rows.length ? <Results q={q} rows={rows} active={active} setActive={setActive} /> : q.trim() ? <Empty art="search" title={`没有找到「${q}」`} /> : null}
        </div>
      </main>
    </Layout>
  );
}
