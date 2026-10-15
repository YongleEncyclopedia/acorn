import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Menu as MenuIcon, Search as SearchIcon } from "lucide-react";
import { Layout } from "./Layout.tsx";
import { api } from "../lib/api.ts";
import { fullDate, relTime } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { Empty } from "../components/Empty.tsx";
import type { Highlight } from "../../../src/shared/types.ts";

function hrefFor(h: Highlight): string {
  return h.archiveId ? `/archive/${h.archiveId}` : `/entry/${h.entryId}`;
}

async function exportMarkdown(): Promise<void> {
  const all: Highlight[] = [];
  let cursor: string | null = null;
  do {
    const page = await api.highlights(undefined, cursor);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && all.length < 20000);
  const groups = new Map<string, Highlight[]>();
  for (const h of all) {
    const k = `${h.title || "无标题"}\u0000${h.url || ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(h);
  }
  const lines = [`# 松果批注`, "", `导出于 ${fullDate(Date.now())}，共 ${all.length} 条。`, ""];
  for (const [k, list] of groups) {
    const [title, url] = k.split("\u0000");
    lines.push(`## ${title}`, "", url ? `来源：<${url}>${list[0].source ? ` · ${list[0].source}` : ""}` : "", "");
    for (const h of list.sort((a, b) => a.createdAt - b.createdAt)) {
      lines.push(`> ${h.quote.replace(/\n/g, "\n> ")}`, "");
      if (h.note) lines.push(h.note, "");
      lines.push(`<sub>${fullDate(h.createdAt)}</sub>`, "");
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `acorn-notes-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function NotesPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const list = useInfiniteQuery({
    queryKey: ["highlights", debounced],
    queryFn: ({ pageParam }) => api.highlights(debounced || undefined, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = useMemo(() => {
    const out: { key: string; title: string; source: string | null; href: string; at: number; items: Highlight[] }[] = [];
    for (const h of items) {
      const key = `${h.entryId || ""}-${h.archiveId || ""}-${h.title}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(h);
      else out.push({ key, title: h.title || "无标题", source: h.source || null, href: hrefFor(h), at: h.createdAt, items: [h] });
    }
    return out;
  }, [items]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.hasNextPage) return;
    const io = new IntersectionObserver((x) => x[0].isIntersecting && list.fetchNextPage(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [list, items.length]);

  return (
    <Layout mode="wide">
      <main className="pane wide-pane scroll" style={{ overflowY: "auto" }}>
        <header className="pane-head" style={{ background: "transparent", backdropFilter: "none" }}>
          <button className="icon-btn menu-btn" onClick={() => ui.set({ drawer: true })} aria-label="打开导航">
            <MenuIcon size={20} />
          </button>
        </header>
        <div className="page narrow">
          <div className="page-hero">
            <div>
              <h1>批注</h1>
              <div className="lede">读到的好句子和你的想法，都在这里。批注过的文章会自动入藏。</div>
            </div>
            <div className="actions">
              <button
                className="btn"
                onClick={() =>
                  exportMarkdown().then(
                    () => toast("已导出 Markdown，可以直接放进 Obsidian"),
                    (e) => toastError(e),
                  )
                }
              >
                <Download size={16} />
                导出 Markdown
              </button>
            </div>
          </div>
          <div className="toolbar-row">
            <div className="search-field" style={{ maxWidth: "none" }}>
              <SearchIcon size={16} />
              <input className="field" placeholder="搜索批注和想法…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {list.isLoading ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : groups.length ? (
            groups.map((g) => (
              <section key={g.key + g.at} className="note-group">
                <div className="note-group-head">
                  <Link href={g.href}>
                    <h3>{g.title}</h3>
                  </Link>
                  <span className="src">
                    {g.source ? `${g.source} · ` : ""}
                    {relTime(g.at)}
                  </span>
                </div>
                {g.items.map((h) => (
                  <Link key={h.id} href={g.href} className="note-card">
                    <span className="bar" style={{ background: `var(--hl-${h.color}-solid)` }} />
                    <div>
                      <blockquote>{h.quote}</blockquote>
                      {h.note && <div className="note">{h.note}</div>}
                    </div>
                  </Link>
                ))}
              </section>
            ))
          ) : (
            <Empty art="notes" title={debounced ? "没有找到相关批注" : "还没有批注"}>
              在文章里选中一段文字，选个颜色就能高亮；点「批注」可以写下想法。
            </Empty>
          )}
          <div ref={sentinel} />
        </div>
      </main>
    </Layout>
  );
}
