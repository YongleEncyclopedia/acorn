import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Globe, Puzzle, Rss, Sparkles, Wand2 } from "lucide-react";
import { Dialog } from "../components/Dialog.tsx";
import { Segmented, Switch } from "../components/Controls.tsx";
import { api } from "../lib/api.ts";
import { keys, useBootstrap } from "../lib/queries.ts";
import { shortDate } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import type { FeedConfig, FeedKind, FeedPreview, FullTextMode, HtmlRule, PreviewItem } from "../../../src/shared/types.ts";

const KIND_LABEL: Record<FeedKind, string> = { feed: "RSS", rsshub: "RSSHub", html: "网页", plugin: "插件" };

export function KindBadge({ kind }: { kind: FeedKind }) {
  return <span className={`badge ${kind === "html" ? "warn" : kind === "rsshub" ? "accent" : kind === "plugin" ? "ok" : ""}`}>{KIND_LABEL[kind]}</span>;
}

export function PreviewList({ items }: { items: PreviewItem[] }) {
  if (!items.length) return <div className="callout plain">没有读到条目。</div>;
  return (
    <div className="preview-list">
      {items.slice(0, 8).map((it, i) => (
        <div key={i} className="preview-item">
          <span className="t" title={it.title}>
            {it.title}
          </span>
          <span className="d">{it.publishedAt ? shortDate(it.publishedAt) : "无日期"}</span>
        </div>
      ))}
    </div>
  );
}

export function RuleEditor({ rule, onChange }: { rule: HtmlRule; onChange: (r: HtmlRule) => void }) {
  const f = (k: keyof HtmlRule, label: string, ph: string) => (
    <div className="form-row">
      <label className="lbl">{label}</label>
      <input className="field mono" placeholder={ph} value={rule[k] || ""} onChange={(e) => onChange({ ...rule, [k]: e.target.value || undefined })} />
    </div>
  );
  return (
    <div className="form-grid">
      {f("item", "列表项（必填）", "ul.news > li")}
      <div className="two-col">
        {f("title", "标题（默认取第一个链接）", "a")}
        {f("link", "链接（默认 a@href）", "a@href")}
      </div>
      <div className="two-col">
        {f("date", "日期（默认自动识别）", "span.date")}
        {f("summary", "摘要（可选）", "p")}
      </div>
      <div className="help" style={{ fontSize: 12, color: "var(--ink-3)" }}>
        写法是 CSS 选择器，末尾加 <code>@属性</code> 可以取属性值。不会写也没关系：让 Claude Code 帮你改，或者在 plugins 目录写一个插件。
      </div>
    </div>
  );
}

const RSSHUB_EXAMPLES = [
  { label: "B 站 UP 主动态", route: "/bilibili/user/dynamic/2267573" },
  { label: "知乎热榜", route: "/zhihu/hot" },
  { label: "微博热搜", route: "/weibo/search/hot" },
  { label: "GitHub Trending", route: "/github/trending/daily/any" },
  { label: "少数派 Matrix", route: "/sspai/matrix" },
];

function AddSourceDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"url" | "rsshub" | "plugin">("url");
  const [input, setInput] = useState(initial || "");
  const [pluginId, setPluginId] = useState(boot.data?.plugins.find((p) => !p.error)?.id || "");
  const [params, setParams] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [rule, setRule] = useState<HtmlRule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "add">("");
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState<string>("");
  const [newFolder, setNewFolder] = useState("");
  const [fullText, setFullText] = useState<FullTextMode>("auto");
  const [autoArchive, setAutoArchive] = useState(false);
  const plugin = boot.data?.plugins.find((p) => p.id === pluginId);

  const kind: FeedKind | undefined = tab === "rsshub" ? "rsshub" : tab === "plugin" ? "plugin" : preview?.kind === "html" && rule ? "html" : undefined;
  const config: FeedConfig | undefined = tab === "plugin" ? { plugin: { id: pluginId, params } } : kind === "html" && rule ? { html: rule } : undefined;
  const source = tab === "plugin" ? pluginId : tab === "rsshub" ? (input.startsWith("rsshub://") ? input : `rsshub:/${input.startsWith("/") ? "" : "/"}${input}`) : input;

  const runPreview = async (override?: { input?: string; kind?: FeedKind; config?: FeedConfig }) => {
    setBusy("preview");
    setError("");
    try {
      const p = await api.preview(override?.input ?? source, override?.kind ?? kind, override?.config ?? config);
      setPreview(p);
      if (p.suggestedRule && !override?.config) setRule(p.suggestedRule);
      if (p.kind === "html") setFullText("always");
      if (!title && p.title) setTitle("");
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (initial) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = async (overrideInput?: string) => {
    setBusy("add");
    setError("");
    try {
      const folderId = folder && folder !== "__new" ? Number(folder) : null;
      const r = await api.addFeed({
        input: overrideInput ?? (preview?.kind === "html" && rule ? preview.url : source),
        kind: overrideInput ? "feed" : preview?.kind === "html" && rule ? "html" : kind,
        config: preview?.kind === "html" && rule ? { html: rule } : config,
        title: title.trim() || undefined,
        folderId,
        folderName: folder === "__new" ? newFolder.trim() : undefined,
        fullText,
        autoArchive,
      });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
      qc.invalidateQueries({ queryKey: ["entries"] });
      toast(r.existed ? "已经订阅过了" : `已订阅「${r.feed.title}」${r.added ? `，收到 ${r.added} 篇` : ""}`);
      onClose();
      navigate(`/feed/${r.feed.id}`);
    } catch (e) {
      const err = e as Error & { data?: { preview?: FeedPreview } };
      if (err.data?.preview) setPreview(err.data.preview);
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const folders = boot.data?.folders || [];
  const canSubscribe = !!preview && (preview.items.length > 0 || (preview.kind === "html" && !!rule)) && !preview.candidates.length;

  const options = (
    <div className="form-grid" style={{ marginTop: 16 }}>
      <div className="two-col">
        <div className="form-row">
          <label className="lbl">名称</label>
          <input className="field" placeholder={preview?.title || "自动"} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="lbl">分组</label>
          <select className="field" value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">不分组</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="__new">新建分组…</option>
          </select>
          {folder === "__new" && <input className="field" style={{ marginTop: 8 }} placeholder="分组名称" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} autoFocus />}
        </div>
      </div>
      <div className="setting-row" style={{ padding: "4px 0", border: 0, minHeight: 0 }}>
        <div className="txt">
          <b>全文</b>
          <span>摘要型订阅源会自动打开原网页提取全文</span>
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
      <div className="setting-row" style={{ padding: "4px 0", border: 0, minHeight: 0 }}>
        <div className="txt">
          <b>新文章自动入藏</b>
          <span>每一篇都保存到本地。适合容易被删的来源，比如公众号。</span>
        </div>
        <Switch checked={autoArchive} onChange={setAutoArchive} label="自动入藏" />
      </div>
    </div>
  );

  return (
    <Dialog
      title="添加订阅"
      size="lg"
      onClose={onClose}
      icon={<Rss size={20} color="var(--accent)" />}
      footer={
        <>
          {error && <span style={{ color: "var(--danger)", fontSize: 13, marginRight: "auto", lineHeight: 1.5 }}>{error}</span>}
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!canSubscribe || !!busy} onClick={() => subscribe()}>
            {busy === "add" ? <span className="spinner" /> : <Check size={16} />}
            订阅
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 14 }}>
        <Segmented
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPreview(null);
            setError("");
          }}
          options={[
            { value: "url", label: <><Globe size={14} />网址</> },
            { value: "rsshub", label: <><Sparkles size={14} />RSSHub</> },
            { value: "plugin", label: <><Puzzle size={14} />插件</> },
          ]}
        />
      </div>
      {tab === "url" && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="field"
            autoFocus
            placeholder="网址、RSS 地址、rsshub://路由，或学院的通知公告页"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && input.trim() && runPreview()}
          />
          <button className="btn" disabled={!input.trim() || !!busy} onClick={() => runPreview()}>
            {busy === "preview" ? <span className="spinner" /> : <Wand2 size={16} />}
            识别
          </button>
        </div>
      )}
      {tab === "rsshub" && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field mono" autoFocus placeholder="/bilibili/user/dynamic/2267573" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && input.trim() && runPreview()} />
            <button className="btn" disabled={!input.trim() || !!busy} onClick={() => runPreview()}>
              {busy === "preview" ? <span className="spinner" /> : <Wand2 size={16} />}
              预览
            </button>
          </div>
          <div className="toolbar-row" style={{ marginTop: 10, marginBottom: 0 }}>
            {RSSHUB_EXAMPLES.map((x) => (
              <button key={x.route} className="chip" onClick={() => setInput(x.route)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="help" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>
            当前实例：{boot.data?.settings.rsshubBase || "https://rsshub.app"}。全部路由见 <a href="https://docs.rsshub.app/zh/routes/popular" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-ink)" }}>RSSHub 文档</a>；需要 Cookie 的路由（微博、B 站动态等）建议自建实例。
          </div>
        </>
      )}
      {tab === "plugin" &&
        (boot.data?.plugins.length ? (
          <div className="form-grid">
            <select className="field" value={pluginId} onChange={(e) => setPluginId(e.target.value)}>
              {boot.data.plugins.map((p) => (
                <option key={p.id} value={p.id} disabled={!!p.error}>
                  {p.name}
                  {p.error ? "（加载失败）" : ""}
                </option>
              ))}
            </select>
            {plugin?.description && <div className="callout plain">{plugin.description}</div>}
            {plugin?.params.map((p) => (
              <div key={p.key} className="form-row">
                <label className="lbl">
                  {p.label}
                  {p.required ? "" : "（可选）"}
                </label>
                <input className="field" placeholder={p.placeholder} value={params[p.key] || ""} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />
              </div>
            ))}
            <button className="btn" style={{ justifySelf: "start" }} disabled={!pluginId || !!busy} onClick={() => runPreview()}>
              {busy === "preview" ? <span className="spinner" /> : <Wand2 size={16} />}
              运行预览
            </button>
          </div>
        ) : (
          <div className="callout plain">还没有插件。把 TypeScript 文件放进项目的 plugins 目录就会出现在这里，可以让 Claude Code 帮你写。</div>
        ))}

      {preview && (
        <div style={{ marginTop: 18 }}>
          {preview.kind === "feed" && preview.candidates.length > 0 && !preview.items.length ? (
            <>
              <div className="callout" style={{ marginBottom: 10 }}>
                这个网页提供了 {preview.candidates.length} 个订阅源，选一个：
              </div>
              <div className="preview-list">
                {preview.candidates.map((c) => (
                  <button key={c.url} className="preview-item" style={{ width: "100%", textAlign: "left" }} onClick={() => subscribe(c.url)}>
                    <span className="t">{c.title || c.url}</span>
                    <span className="d">{c.url}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <KindBadge kind={preview.kind} />
                <b style={{ fontSize: 15 }}>{preview.title || preview.url}</b>
                <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto" }}>
                  {preview.items.length} 条
                </span>
              </div>
              {preview.kind === "html" && (
                <>
                  {preview.candidates.length > 0 && (
                    <div className="callout plain" style={{ marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <span>这个网站另外提供了整站订阅源：</span>
                      {preview.candidates.map((c) => (
                        <button key={c.url} className="chip" onClick={() => subscribe(c.url)}>
                          {c.title || c.url}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="callout" style={{ marginBottom: 12 }}>
                    {rule ? "这个网页没有 RSS。松果认出了页面上的文章列表，会定期检查有没有新条目。" : "这个网页没有 RSS，也没能自动识别出文章列表。可以手动填写选择器。"}
                  </div>
                  <RuleEditor rule={rule || { item: "" }} onChange={setRule} />
                  <button className="btn sm" style={{ marginTop: 10 }} disabled={!rule?.item || !!busy} onClick={() => runPreview({ input: preview.url, kind: "html", config: { html: rule! } })}>
                    {busy === "preview" ? <span className="spinner" /> : <Wand2 size={14} />}
                    按这个规则重新预览
                  </button>
                  <div style={{ height: 12 }} />
                </>
              )}
              <PreviewList items={preview.items} />
              {options}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function AddSourceHost() {
  const state = ui.use((s) => s.addSource);
  const key = useMemo(() => Math.random(), [state]);
  if (!state) return null;
  return <AddSourceDialog key={key} initial={state.input} onClose={() => ui.set({ addSource: null })} />;
}
