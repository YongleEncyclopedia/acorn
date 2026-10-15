import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Download, FolderPlus, Menu as MenuIcon, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { Layout } from "./Layout.tsx";
import { KindBadge, PreviewList, RuleEditor } from "./AddSource.tsx";
import { api } from "../lib/api.ts";
import { keys, useBootstrap } from "../lib/queries.ts";
import { relTime, hostname, fullDate } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Segmented, Switch } from "../components/Controls.tsx";
import { Popover, Menu, useAnchor } from "../components/Popover.tsx";
import { Empty } from "../components/Empty.tsx";
import type { Feed, FeedConfig, FullTextMode, HtmlRule, PreviewItem } from "../../../src/shared/types.ts";

const INTERVALS = [
  { v: "", label: "默认" },
  { v: "10", label: "10 分钟" },
  { v: "30", label: "30 分钟" },
  { v: "60", label: "1 小时" },
  { v: "180", label: "3 小时" },
  { v: "360", label: "6 小时" },
  { v: "720", label: "12 小时" },
  { v: "1440", label: "每天" },
];

function FeedEditor({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const qc = useQueryClient();
  const boot = useBootstrap();
  const [name, setName] = useState(feed.customTitle || "");
  const [folder, setFolder] = useState(feed.folderId ? String(feed.folderId) : "");
  const [newFolder, setNewFolder] = useState("");
  const [url, setUrl] = useState(feed.url);
  const [fullText, setFullText] = useState<FullTextMode>(feed.fullText);
  const [autoArchive, setAutoArchive] = useState(feed.autoArchive);
  const [interval, setIntervalV] = useState(feed.fetchInterval ? String(feed.fetchInterval) : "");
  const [paused, setPaused] = useState(feed.paused);
  const [rule, setRule] = useState<HtmlRule>(feed.config.html || { item: "" });
  const [params, setParams] = useState<Record<string, string>>(feed.config.plugin?.params || {});
  const [contentSelector, setContentSelector] = useState(feed.config.contentSelector || "");
  const [cookie, setCookie] = useState(feed.config.cookie || "");
  const [ua, setUa] = useState(feed.config.userAgent || "");
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const logs = useQuery({ queryKey: ["feed-logs", feed.id], queryFn: () => api.feedLogs(feed.id) });
  const plugin = boot.data?.plugins.find((p) => p.id === feed.url);

  const config = (): FeedConfig => {
    const c: FeedConfig = { ...feed.config };
    if (feed.kind === "html") c.html = rule;
    if (feed.kind === "plugin") c.plugin = { id: feed.url, params };
    if (contentSelector.trim()) c.contentSelector = contentSelector.trim();
    else delete c.contentSelector;
    if (cookie.trim()) c.cookie = cookie.trim();
    else delete c.cookie;
    if (ua.trim()) c.userAgent = ua.trim();
    else delete c.userAgent;
    return c;
  };

  const save = async () => {
    setBusy(true);
    try {
      let folderId: number | null = folder ? Number(folder) : null;
      if (folder === "__new" && newFolder.trim()) folderId = (await api.createFolder(newFolder.trim())).id;
      await api.patchFeed(feed.id, {
        customTitle: name.trim() || null,
        folderId,
        fullText,
        autoArchive,
        fetchInterval: interval ? Number(interval) : null,
        paused,
        config: config(),
        ...(url !== feed.url ? { url } : {}),
      });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
      toast("已保存");
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const testRule = async () => {
    setBusy(true);
    try {
      const p = await api.preview(feed.kind === "rsshub" ? `rsshub:/${url}` : url, feed.kind, config());
      setPreview(p.items);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`取消订阅「${feed.title}」？文章会一起删除，已入藏的存档会保留。`)) return;
    await api.deleteFeed(feed.id).catch(toastError);
    qc.invalidateQueries({ queryKey: keys.bootstrap });
    qc.invalidateQueries({ queryKey: ["entries"] });
    onClose();
  };

  return (
    <Dialog
      title={feed.title}
      icon={<FeedIcon feed={feed} large />}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="btn ghost danger" style={{ marginRight: "auto" }} onClick={remove}>
            <Trash2 size={15} />
            取消订阅
          </button>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="two-col">
          <div className="form-row">
            <label className="lbl">名称</label>
            <input className="field" placeholder={feed.originalTitle} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="lbl">分组</label>
            <select className="field" value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">不分组</option>
              {boot.data?.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="__new">新建分组…</option>
            </select>
            {folder === "__new" && <input className="field" style={{ marginTop: 8 }} placeholder="分组名称" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />}
          </div>
        </div>
        {feed.kind !== "plugin" && (
          <div className="form-row">
            <label className="lbl">
              {feed.kind === "rsshub" ? "RSSHub 路由" : feed.kind === "html" ? "网页地址" : "订阅地址"} <KindBadge kind={feed.kind} />
            </label>
            <input className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
        )}
        {feed.kind === "html" && <RuleEditor rule={rule} onChange={setRule} />}
        {feed.kind === "plugin" &&
          (plugin?.params || []).map((p) => (
            <div key={p.key} className="form-row">
              <label className="lbl">{p.label}</label>
              <input className="field" value={params[p.key] || ""} placeholder={p.placeholder} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />
            </div>
          ))}
        {(feed.kind === "html" || feed.kind === "plugin" || feed.kind === "rsshub") && (
          <div>
            <button className="btn sm" onClick={testRule} disabled={busy}>
              {busy ? <span className="spinner" /> : <RefreshCw size={14} />}
              预览抓取结果
            </button>
            {preview && (
              <div style={{ marginTop: 10 }}>
                <PreviewList items={preview} />
              </div>
            )}
          </div>
        )}
        <div className="settings-card">
          <div className="setting-row">
            <div className="txt">
              <b>全文</b>
              <span>「自动」只在订阅源给的是摘要时去抓原网页</span>
            </div>
            <Segmented
              value={fullText}
              onChange={setFullText}
              options={[
                { value: "auto", label: "自动" },
                { value: "always", label: "总是" },
                { value: "never", label: "不抓" },
              ]}
            />
          </div>
          <div className="setting-row">
            <div className="txt">
              <b>新文章自动入藏</b>
              <span>每篇新文章都保存到本地</span>
            </div>
            <Switch checked={autoArchive} onChange={setAutoArchive} />
          </div>
          <div className="setting-row">
            <div className="txt">
              <b>更新频率</b>
            </div>
            <select className="field" style={{ width: 130 }} value={interval} onChange={(e) => setIntervalV(e.target.value)}>
              {INTERVALS.map((i) => (
                <option key={i.v} value={i.v}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div className="txt">
              <b>暂停更新</b>
            </div>
            <Switch checked={paused} onChange={setPaused} />
          </div>
        </div>
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--ink-2)", fontWeight: 600 }}>高级</summary>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="form-row">
              <label className="lbl">正文选择器（全文提取不准时填写）</label>
              <input className="field mono" placeholder="article .content" value={contentSelector} onChange={(e) => setContentSelector(e.target.value)} />
            </div>
            <div className="form-row">
              <label className="lbl">Cookie（需要登录才能看的网站）</label>
              <textarea className="field mono" rows={2} value={cookie} onChange={(e) => setCookie(e.target.value)} />
            </div>
            <div className="form-row">
              <label className="lbl">User-Agent</label>
              <input className="field mono" value={ua} onChange={(e) => setUa(e.target.value)} />
            </div>
          </div>
        </details>
        <div>
          <div className="lbl" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginBottom: 6 }}>
            抓取记录
          </div>
          <div className="preview-list">
            {(logs.data || []).slice(0, 8).map((l, i) => (
              <div key={i} className="preview-item">
                <span className={`badge ${l.status === "error" ? "seal" : l.status === "ok" ? "ok" : ""}`}>{l.status === "ok" ? `+${l.added}` : l.status === "not_modified" ? "无变化" : "失败"}</span>
                <span className="t" style={{ color: l.error ? "var(--danger)" : "var(--ink-3)" }} title={l.error || ""}>
                  {l.error || `${l.ms} ms`}
                </span>
                <span className="d">{fullDate(l.at)}</span>
              </div>
            ))}
            {!logs.data?.length && <div className="preview-item muted">还没有抓取记录</div>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Row({ feed, onEdit }: { feed: Feed; onEdit: () => void }) {
  const qc = useQueryClient();
  const menu = useAnchor();
  const [spin, setSpin] = useState(false);
  const refresh = async () => {
    setSpin(true);
    try {
      const r = await api.refreshFeed(feed.id, true);
      toast(r.error ? `失败：${r.error}` : r.added ? `新到 ${r.added} 篇` : "没有新文章", { kind: r.error ? "error" : "info" });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
      qc.invalidateQueries({ queryKey: ["entries"] });
    } catch (e) {
      toastError(e);
    } finally {
      setSpin(false);
    }
  };
  return (
    <div className="source-row">
      <FeedIcon feed={feed} large />
      <div style={{ minWidth: 0 }}>
        <Link href={`/feed/${feed.id}`} className="name">
          {feed.title}
        </Link>
        <div className="sub">
          <KindBadge kind={feed.kind} />
          {feed.paused && <span className="badge">已暂停</span>}
          {feed.autoArchive && <span className="badge seal">自动入藏</span>}
          <span className="url">{feed.kind === "rsshub" ? feed.url : feed.kind === "plugin" ? `插件 ${feed.url}` : hostname(feed.siteUrl || feed.url)}</span>
          <span>·</span>
          <span className="tabular">
            {feed.unread}/{feed.total}
          </span>
          {feed.lastSuccessAt && <span>· {relTime(feed.lastSuccessAt)}</span>}
        </div>
        {feed.errorCount > 0 && feed.lastError && <div className="err-msg">连续 {feed.errorCount} 次失败：{feed.lastError}</div>}
      </div>
      <div className="acts">
        <button className="icon-btn sm" onClick={refresh} title="立即刷新" aria-label="立即刷新">
          <RefreshCw size={15} className={spin ? "spin-slow" : ""} />
        </button>
        <button className="icon-btn sm" onClick={onEdit} title="编辑" aria-label="编辑">
          <Pencil size={15} />
        </button>
        <button ref={menu.ref} className="icon-btn sm" onClick={menu.toggle} aria-label="更多">
          <MoreHorizontal size={16} />
        </button>
      </div>
      {menu.open && (
        <Popover anchor={menu.el} onClose={menu.close}>
          <Menu
            onClose={menu.close}
            items={[
              {
                label: "全部标为已读",
                icon: <CheckCheck size={15} />,
                onSelect: () => api.mark({ feedId: feed.id }).then(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), toastError),
              },
              {
                label: feed.paused ? "恢复更新" : "暂停更新",
                icon: feed.paused ? <Play size={15} /> : <Pause size={15} />,
                onSelect: () => api.patchFeed(feed.id, { paused: !feed.paused }).then(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), toastError),
              },
              "sep",
              {
                label: "取消订阅",
                icon: <Trash2 size={15} />,
                danger: true,
                onSelect: async () => {
                  if (!window.confirm(`取消订阅「${feed.title}」？`)) return;
                  await api.deleteFeed(feed.id).catch(toastError);
                  qc.invalidateQueries({ queryKey: keys.bootstrap });
                },
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

export function SourcesPage() {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const search = useSearch();
  const [, navigate] = useLocation();
  const editId = Number(new URLSearchParams(search).get("edit") || 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<"all" | "failing">("all");
  const feeds = boot.data?.feeds || [];
  const editing = feeds.find((f) => f.id === editId);
  const groups = useMemo(() => {
    const list = filter === "failing" ? feeds.filter((f) => f.errorCount > 0) : feeds;
    const out: { id: number | null; name: string; feeds: Feed[] }[] = (boot.data?.folders || []).map((f) => ({ id: f.id, name: f.name, feeds: list.filter((x) => x.folderId === f.id) }));
    out.push({ id: null, name: "未分组", feeds: list.filter((x) => !x.folderId) });
    return out.filter((g) => g.feeds.length);
  }, [feeds, boot.data?.folders, filter]);
  useEffect(() => {
    if (editId && boot.data && !editing) navigate("/sources");
  }, [editId, editing, boot.data, navigate]);

  const importOpml = async (file: File) => {
    try {
      const r = await api.importOpml(file);
      toast(`导入 ${r.added} 个订阅源${r.skipped ? `，跳过 ${r.skipped} 个重复的` : ""}，正在抓取…`);
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (e) {
      toastError(e);
    }
  };
  const renameFolder = async (id: number, name: string) => {
    const next = window.prompt("分组名称", name);
    if (!next || next === name) return;
    await api.patchFolder(id, { name: next }).catch(toastError);
    qc.invalidateQueries({ queryKey: keys.bootstrap });
  };
  const failing = feeds.filter((f) => f.errorCount > 0).length;

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
              <h1>订阅</h1>
              <div className="lede">
                {feeds.length} 个来源{failing ? `，${failing} 个最近抓取失败` : "，都在正常更新"}。
              </div>
            </div>
            <div className="actions">
              <button className="btn" onClick={() => fileInput.current?.click()} title="导入 OPML">
                <Upload size={16} />
                导入
              </button>
              <a className="btn" href="/api/opml" title="导出 OPML">
                <Download size={16} />
                导出
              </a>
              <button className="btn primary" onClick={() => ui.set({ addSource: {} })}>
                <Plus size={16} />
                添加
              </button>
              <input ref={fileInput} type="file" accept=".opml,.xml,text/xml" hidden onChange={(e) => e.target.files?.[0] && importOpml(e.target.files[0])} />
            </div>
          </div>
          <div className="toolbar-row">
            <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              全部 <span className="count">{feeds.length}</span>
            </button>
            <button className="chip" aria-pressed={filter === "failing"} onClick={() => setFilter("failing")}>
              抓取失败 <span className="count">{failing}</span>
            </button>
            <span className="grow" />
            <button
              className="btn sm ghost"
              onClick={async () => {
                const name = window.prompt("新分组名称");
                if (name?.trim()) {
                  await api.createFolder(name.trim()).catch(toastError);
                  qc.invalidateQueries({ queryKey: keys.bootstrap });
                }
              }}
            >
              <FolderPlus size={15} />
              新建分组
            </button>
          </div>
          {groups.length ? (
            groups.map((g) => (
              <section key={g.id ?? "none"} className="folder-block">
                <h3>
                  {g.name}
                  <span className="muted" style={{ fontWeight: 500 }}>
                    {g.feeds.length}
                  </span>
                  {g.id && (
                    <>
                      <button className="icon-btn sm" onClick={() => renameFolder(g.id!, g.name)} aria-label="重命名分组">
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-btn sm"
                        aria-label="删除分组"
                        onClick={async () => {
                          if (!window.confirm(`删除分组「${g.name}」？里面的订阅会变成未分组。`)) return;
                          await api.deleteFolder(g.id!).catch(toastError);
                          qc.invalidateQueries({ queryKey: keys.bootstrap });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </h3>
                <div className="source-list">
                  {g.feeds.map((f) => (
                    <Row key={f.id} feed={f} onEdit={() => navigate(`/sources?edit=${f.id}`)} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <Empty
              art="acorn"
              title={filter === "failing" ? "没有失败的订阅源" : "还没有订阅"}
              action={
                filter === "all" ? (
                  <button className="btn primary" onClick={() => ui.set({ addSource: {} })}>
                    添加订阅
                  </button>
                ) : undefined
              }
            />
          )}
          {!!boot.data?.plugins.length && (
            <section className="settings-section" style={{ marginTop: 32 }}>
              <h2>插件 · plugins/</h2>
              <div className="settings-card">
                {boot.data.plugins.map((p) => (
                  <div key={p.id} className="setting-row">
                    <div className="txt">
                      <b>{p.name}</b>
                      <span>{p.error ? `加载失败：${p.error}` : p.description || p.id}</span>
                    </div>
                    <span className="badge">{p.id}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      {editing && <FeedEditor key={editing.id} feed={editing} onClose={() => navigate("/sources")} />}
    </Layout>
  );
}
