import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FileUp, Globe, Highlighter, Layers, Link2, Menu as MenuIcon, Search as SearchIcon } from "lucide-react";
import { Layout } from "./Layout.tsx";
import { api } from "../lib/api.ts";
import { useBootstrap } from "../lib/queries.ts";
import { bytes, relTime, shortDate } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { Seal } from "../components/Seal.tsx";
import { Empty } from "../components/Empty.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Segmented } from "../components/Controls.tsx";
import type { ArchiveSummary } from "../../../src/shared/types.ts";

function Card({ a }: { a: ArchiveSummary }) {
  const [imgOk, setImgOk] = useState(true);
  const gone = a.sourceStatus === "gone";
  return (
    <Link href={`/archive/${a.id}`} className={`archive-card ${gone ? "gone" : ""}`}>
      {a.leadImage && imgOk && <img className="cover" src={a.leadImage} alt="" loading="lazy" onError={() => setImgOk(false)} />}
      {(!a.leadImage || !imgOk) && <Seal size="sm" />}
      <div className="body">
        <div className="site">
          <span>{a.site || "网页"}</span>
          {a.publishedAt && <span className="muted">· {shortDate(a.publishedAt)}</span>}
        </div>
        <h3>{a.title}</h3>
        {a.excerpt && <p className="ex">{a.excerpt}</p>}
        <div className="foot">
          {gone && <span className="badge seal">原文已消失</span>}
          {a.sourceStatus === "changed" && <span className="badge warn">原文改过</span>}
          {a.snapshotCount > 1 && (
            <span className="badge">
              <Layers size={11} />
              {a.snapshotCount} 个版本
            </span>
          )}
          {a.highlightCount > 0 && (
            <span className="badge accent">
              <Highlighter size={11} />
              {a.highlightCount}
            </span>
          )}
          {a.tags.slice(0, 3).map((t) => (
            <span key={t} className="badge">
              #{t}
            </span>
          ))}
          <span style={{ marginLeft: "auto" }}>藏于 {relTime(a.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}

export function CaptureDialog({ onClose, initialUrl = "" }: { onClose: () => void; initialUrl?: string }) {
  const boot = useBootstrap();
  const [, navigate] = useLocation();
  const [url, setUrl] = useState(initialUrl);
  const [method, setMethod] = useState<"fetch" | "browser">("fetch");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.capture({ url: url.trim(), method, tags: tags.split(/[,，\s]+/).filter(Boolean), wait: true });
      if (r.warnings?.length) toast(r.warnings[0]);
      else toast(r.unchanged ? "这篇已经藏过，内容没有变化" : "已入藏");
      onClose();
      if (r.archiveId) navigate(`/archive/${r.archiveId}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="入藏一个网页"
      size="sm"
      onClose={onClose}
      icon={<Seal size="sm" />}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!/^https?:\/\//.test(url.trim()) || busy} onClick={submit}>
            {busy ? <span className="spinner" /> : "入藏"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-row">
          <label className="lbl">网址</label>
          <input className="field" autoFocus placeholder="https://mp.weixin.qq.com/s/…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>
        <div className="form-row">
          <label className="lbl">方式</label>
          <Segmented
            value={method}
            onChange={setMethod}
            options={[
              { value: "fetch", label: "服务器抓取" },
              ...(boot.data?.egoBrowser ? [{ value: "browser" as const, label: <><Globe size={14} />我的浏览器</> }] : []),
            ]}
          />
          <div className="help">
            {method === "browser" ? "在这台电脑上用你已登录的浏览器打开，连同整页快照（MHTML）和截图一起保存。适合公众号、小红书、知乎。" : "松果直接抓取网页，提取正文并把图片下载到本地。"}
          </div>
        </div>
        <div className="form-row">
          <label className="lbl">标签（可选）</label>
          <input className="field" placeholder="用空格或逗号分隔" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    if (/\.mht(ml)?$/i.test(file.name)) fd.append("mhtml", file);
    else fd.append("html", file);
    if (url.trim()) fd.append("url", url.trim());
    try {
      const r = await api.importArchive(fd);
      toast(`已导入 · ${r.title}`);
      onClose();
      navigate(`/archive/${r.archiveId}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="导入保存好的网页"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!file || busy || (!/\.mht(ml)?$/i.test(file?.name || "") && !/^https?:\/\//.test(url))} onClick={submit}>
            {busy ? <span className="spinner" /> : "导入"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="callout plain">支持浏览器「存储为网页」得到的 .mhtml（推荐，含图片）或 .html 文件。</div>
        <input className="field" type="file" accept=".mhtml,.mht,.html,.htm" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ paddingTop: 8 }} />
        <div className="form-row">
          <label className="lbl">原文网址{file && /\.mht(ml)?$/i.test(file.name) ? "（MHTML 自带，可不填）" : ""}</label>
          <input className="field" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}

export function ArchiveLibrary() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const status = params.get("status") || "";
  const tag = params.get("tag") || "";
  const [q, setQ] = useState(params.get("q") || "");
  const [debounced, setDebounced] = useState(q);
  const [dialog, setDialog] = useState<"capture" | "import" | null>(params.get("capture") ? "capture" : null);
  const boot = useBootstrap();
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const filters = useMemo(() => ({ q: debounced || undefined, status: status || undefined, tag: tag || undefined }), [debounced, status, tag]);
  const list = useInfiniteQuery({
    queryKey: ["archives", filters],
    queryFn: ({ pageParam }) => api.archives(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats, staleTime: 60_000 });
  const tags = useQuery({ queryKey: ["archive-tags"], queryFn: api.archiveTags, staleTime: 60_000 });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !list.hasNextPage) return;
    const io = new IntersectionObserver((x) => x[0].isIntersecting && list.fetchNextPage(), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [list.hasNextPage, list, items.length]);
  const setFilter = (k: string, v: string) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/archive${p.toString() ? `?${p}` : ""}`);
  };
  const c = boot.data?.counts;

  return (
    <Layout mode="wide">
      <main className="pane wide-pane scroll" style={{ overflowY: "auto" }}>
        <header className="pane-head" style={{ background: "transparent", backdropFilter: "none" }}>
          <button className="icon-btn menu-btn" onClick={() => ui.set({ drawer: true })} aria-label="打开导航">
            <MenuIcon size={20} />
          </button>
        </header>
        <div className="page">
          <div className="page-hero">
            <Seal />
            <div>
              <h1>藏</h1>
              <div className="lede">每一篇都完整保存在你的硬盘上：正文、图片、原始网页。原文被删了，这里还在。</div>
            </div>
            <div className="actions">
              <button className="btn" onClick={() => setDialog("import")}>
                <FileUp size={16} />
                导入
              </button>
              <button className="btn primary" onClick={() => setDialog("capture")}>
                <Link2 size={16} />
                入藏网址
              </button>
            </div>
          </div>
          <div className="stat-row">
            <div className="stat">
              <div className="v">{stats.data?.archives ?? c?.archived ?? "–"}</div>
              <div className="k">篇存档</div>
            </div>
            <div className="stat">
              <div className="v">{stats.data ? bytes(stats.data.archiveBytes) : "–"}</div>
              <div className="k">占用空间</div>
            </div>
            <div className="stat lost">
              <div className="v">{c?.gone ?? 0}</div>
              <div className="k">篇原文已消失，幸好你藏了</div>
            </div>
            <div className="stat">
              <div className="v">{c?.highlights ?? 0}</div>
              <div className="k">条批注</div>
            </div>
          </div>
          <div className="toolbar-row">
            <div className="search-field">
              <SearchIcon size={16} />
              <input className="field" placeholder="搜索存档全文…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="chip" aria-pressed={!status} onClick={() => setFilter("status", "")}>
              全部
            </button>
            <button className="chip" aria-pressed={status === "gone"} onClick={() => setFilter("status", status === "gone" ? "" : "gone")}>
              原文已消失 <span className="count">{c?.gone ?? 0}</span>
            </button>
            <button className="chip" aria-pressed={status === "changed"} onClick={() => setFilter("status", status === "changed" ? "" : "changed")}>
              原文改过
            </button>
            {(tags.data || []).slice(0, 12).map((t) => (
              <button key={t.tag} className="chip" aria-pressed={tag === t.tag} onClick={() => setFilter("tag", tag === t.tag ? "" : t.tag)}>
                #{t.tag} <span className="count">{t.count}</span>
              </button>
            ))}
          </div>
          {list.isLoading ? (
            <div className="archive-grid">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="archive-card">
                  <div className="skeleton" style={{ aspectRatio: "16/9", borderRadius: 0 }} />
                  <div className="body">
                    <div className="skeleton" style={{ height: 12, width: "40%" }} />
                    <div className="skeleton" style={{ height: 18, width: "90%" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length ? (
            <div className="archive-grid">
              {items.map((a) => (
                <Card key={a.id} a={a} />
              ))}
            </div>
          ) : (
            <Empty art="vault" title={debounced || status || tag ? "没有符合条件的存档" : "还没有藏任何东西"}>
              在文章上点「稍后读」或高亮一段话，松果会自动把它入藏；也可以直接粘贴网址入藏。
            </Empty>
          )}
          <div ref={sentinel} />
        </div>
      </main>
      {dialog === "capture" && <CaptureDialog onClose={() => setDialog(null)} />}
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
    </Layout>
  );
}
