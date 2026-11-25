import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, Globe, Puzzle, Rss, Send, Sparkles, Wand2 } from "lucide-react";
import { PushInfo } from "../components/PushInfo.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Segmented, Switch } from "../components/Controls.tsx";
import { api } from "../lib/api.ts";
import { keys, useBootstrap } from "../lib/queries.ts";
import { shortDate } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { AccountPicker } from "../components/ConnectAccount.tsx";
import type { FeedConfig, FeedKind, FeedPreview, FullTextMode, HtmlRule, PluginInfo, PluginParam, PreviewItem } from "../../../src/shared/types.ts";

const KIND_LABEL: Record<FeedKind, string> = { feed: "RSS", rsshub: "RSSHub", html: "网页", plugin: "插件" };

// built-in sources that are not plugins to the user
const PLUGIN_LABEL: Record<string, string> = { json: "JSON", watch: "变化", inbox: "推送" };

export function KindBadge({ kind, plugin, browser }: { kind: FeedKind; plugin?: string; browser?: boolean }) {
  const label = (kind === "plugin" && plugin && PLUGIN_LABEL[plugin.split("?")[0]]) || KIND_LABEL[kind];
  return (
    <>
      <span className={`badge ${kind === "html" ? "warn" : kind === "rsshub" ? "accent" : kind === "plugin" ? "ok" : ""}`}>{label}</span>
      {browser && <span className="badge" title="通过你的浏览器读取">浏览器</span>}
    </>
  );
}

export function PreviewList({ items, empty = "没有读到条目。" }: { items: PreviewItem[]; empty?: string }) {
  if (!items.length) return <div className="callout plain">{empty}</div>;
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

/** A starting shelf for an empty reader: feeds checked to work and to carry full text or a good summary. */
const PICKS: { group: string; items: { title: string; url: string; note: string }[] }[] = [
  {
    group: "科技与生活",
    items: [
      { title: "少数派", url: "https://sspai.com/feed", note: "数字生活、效率工具" },
      { title: "爱范儿", url: "https://www.ifanr.com/feed", note: "科技新闻与评测" },
      { title: "极客公园", url: "https://www.geekpark.net/rss", note: "科技公司与创业" },
      { title: "机核", url: "https://www.gcores.com/rss", note: "游戏与流行文化" },
    ],
  },
  {
    group: "博客",
    items: [
      { title: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml", note: "每周五《科技爱好者周刊》" },
      { title: "小众软件", url: "https://www.appinn.com/feed/", note: "好用的小软件" },
      { title: "Simon Willison", url: "https://simonwillison.net/atom/entries/", note: "AI 与工程，英文" },
    ],
  },
  {
    group: "资讯与社区",
    items: [
      { title: "奇客 Solidot", url: "https://www.solidot.org/index.rss", note: "科技资讯短讯" },
      { title: "V2EX", url: "https://www.v2ex.com/index.xml", note: "程序员社区最新主题" },
      { title: "Hacker News 200+", url: "https://hnrss.org/frontpage?points=200", note: "200 分以上的热帖，英文" },
      { title: "The Verge", url: "https://www.theverge.com/rss/index.xml", note: "科技媒体，英文" },
    ],
  },
  {
    group: "论文",
    items: [{ title: "arXiv · cs.AI", url: "https://rss.arxiv.org/rss/cs.AI", note: "人工智能新论文，工作日更新" }],
  },
];

const RSSHUB_EXAMPLES = [
  { label: "B 站 UP 主动态", route: "/bilibili/user/dynamic/2267573" },
  { label: "知乎热榜", route: "/zhihu/hot" },
  { label: "微博热搜", route: "/weibo/search/hot" },
  { label: "GitHub Trending", route: "/github/trending/daily/any" },
  { label: "少数派 Matrix", route: "/sspai/matrix" },
];

const TYPE_IT = "__type__";

/** One plugin parameter: a menu of fixed choices, the account's own (the 星球 it joined…), or typed. */
export function ParamField({ pluginId, param, account, value, onChange }: { pluginId: string; param: PluginParam; account: number | null; value: string; onChange: (v: string) => void }) {
  const [typed, setTyped] = useState(false);
  const choices = useQuery({
    queryKey: ["plugin-choices", pluginId, param.key, account],
    queryFn: () => api.pluginChoices(pluginId, param.key, account),
    enabled: !!param.fromAccount && !!account,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const list = choices.data || [];
  // the first of the account's choices, until another is picked
  useEffect(() => {
    if (param.fromAccount && !typed && !value && list[0]) onChange(list[0].value);
  }, [param.fromAccount, typed, value, list, onChange]);
  if (param.options?.length) {
    return (
      <select className="field" value={value || param.options[0].value} onChange={(e) => onChange(e.target.value)}>
        {param.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (param.fromAccount && !typed && (choices.isLoading || list.length)) {
    return (
      <select className="field" value={value} disabled={choices.isLoading} onChange={(e) => (e.target.value === TYPE_IT ? setTyped(true) : onChange(e.target.value))}>
        {choices.isLoading && <option value="">正在读取…</option>}
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={TYPE_IT}>手动填写…</option>
      </select>
    );
  }
  return (
    <>
      <input className="field" placeholder={param.placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      {param.fromAccount && choices.isError && <div className="help">没能读到可选项：{(choices.error as Error).message}</div>}
    </>
  );
}

/** A plugin's parameters as they start out: menus on their first choice. */
const startParams = (p: PluginInfo | undefined): Record<string, string> => Object.fromEntries((p?.params || []).filter((x) => x.options?.length).map((x) => [x.key, x.options![0].value]));

function AddSourceDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"url" | "rsshub" | "plugin" | "push">("url");
  // a source made of a page or an API the server reads with a built-in plugin (JSON interface, page watch)
  const [draft, setDraft] = useState<{ id: "json" | "watch"; params: Record<string, string> } | null>(null);
  const [errorCode, setErrorCode] = useState("");
  const [pushName, setPushName] = useState("");
  const [pushed, setPushed] = useState<{ id: number; token: string } | null>(null);
  const [input, setInput] = useState(initial || "");
  const [pluginId, setPluginId] = useState(boot.data?.plugins.find((p) => !p.error && p.group !== "hidden")?.id || "");
  const [params, setParams] = useState<Record<string, string>>(() => startParams(boot.data?.plugins.find((p) => p.id === pluginId)));
  const [accountId, setAccountId] = useState<number | null>(null);
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [rule, setRule] = useState<HtmlRule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "add">("");
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState<string>("");
  const [newFolder, setNewFolder] = useState("");
  const [fullText, setFullText] = useState<FullTextMode>("auto");
  const [autoArchive, setAutoArchive] = useState(false);
  const subscribed = useMemo(() => new Set(boot.data?.feeds.map((f) => f.url) || []), [boot.data?.feeds]);
  const plugin = boot.data?.plugins.find((p) => p.id === pluginId);

  const kind: FeedKind | undefined = tab === "rsshub" ? "rsshub" : tab === "plugin" ? "plugin" : preview?.kind === "html" && rule ? "html" : undefined;
  const config: FeedConfig | undefined =
    tab === "plugin" ? { plugin: { id: pluginId, params, ...(plugin?.account && accountId ? { account: accountId } : {}) } } : kind === "html" && rule ? { html: rule } : undefined;
  const choosePlugin = (id: string) => {
    const p = boot.data?.plugins.find((x) => x.id === id);
    setPluginId(id);
    setParams(startParams(p));
    setAccountId(null);
    setPreview(null);
    setError("");
    // platforms behind a sign-in hand over whole articles; their pages show a server nothing
    setFullText(p?.account ? "never" : "auto");
  };
  const pickAccount = useCallback((id: number | null) => setAccountId(id), []);
  const needsAccount = !!plugin?.account && !accountId;
  const source = tab === "plugin" ? pluginId : tab === "rsshub" ? (input.startsWith("rsshub://") ? input : `rsshub:/${input.startsWith("/") ? "" : "/"}${input}`) : input;

  const runPreview = async (override?: { input?: string; kind?: FeedKind; config?: FeedConfig; keepDraft?: boolean }) => {
    setBusy("preview");
    setError("");
    setErrorCode("");
    if (!override?.keepDraft) setDraft(null);
    try {
      const k = override && "kind" in override ? override.kind : kind;
      const p = await api.preview(override?.input ?? source, k, override?.config ?? config);
      setPreview(p);
      if (p.suggestedRule && !override?.config?.html) setRule(p.suggestedRule);
      if (p.json && !override?.keepDraft) setDraft({ id: "json", params: p.json });
      // a page read whole each time, or a site only the browser gets past, has no full text to fetch
      setFullText(p.browser || override?.config?.plugin?.id === "watch" ? "never" : p.kind === "html" ? "always" : "auto");
      if (!title && p.title) setTitle("");
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
      setErrorCode((e as { code?: string }).code || "");
    } finally {
      setBusy("");
    }
  };
  /** Preview a JSON interface or a watched page with the fields as they stand. */
  const previewDraft = (d: { id: "json" | "watch"; params: Record<string, string> }) => {
    setDraft(d);
    return runPreview({ input: `plugin:${d.id}`, kind: "plugin", config: { plugin: { id: d.id, params: d.params } }, keepDraft: true });
  };
  const pageUrl = preview?.resolvedUrl && /^https?:/i.test(preview.resolvedUrl) ? preview.resolvedUrl : /^https?:\/\//i.test(input.trim()) ? input.trim() : /^[\w-]+(\.[\w-]+)+/.test(input.trim()) ? `https://${input.trim()}` : "";
  const inBrowser = () => runPreview({ input: pageUrl || input, kind: undefined, config: { browser: true } });
  const createPush = async () => {
    setBusy("add");
    setError("");
    try {
      const r = await api.addFeed({ input: "plugin:inbox", kind: "plugin", title: pushName.trim() || "推送", config: { plugin: { id: "inbox", params: {} } }, fullText: "never" });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
      setPushed({ id: r.feed.id, token: r.feed.config.plugin?.params?.token || "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (initial) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** What subscribing means for what is on screen. */
  const request = (overrideInput?: string, viaBrowser?: boolean): { input: string; kind?: FeedKind; config?: FeedConfig } => {
    if (overrideInput) return { input: overrideInput, kind: "feed", config: viaBrowser ? { browser: true } : undefined };
    if (tab === "url" && draft) return { input: `plugin:${draft.id}`, kind: "plugin", config: { plugin: { id: draft.id, params: draft.params } } };
    if (tab === "url" && preview?.kind === "html" && rule) return { input: preview.url, kind: "html", config: { html: rule, ...(preview.browser ? { browser: true } : {}) } };
    if (tab === "url" && preview?.browser && preview.kind === "feed") return { input: preview.url, kind: "feed", config: { browser: true } };
    return { input: source, kind, config };
  };

  const subscribe = async (overrideInput?: string, viaBrowser?: boolean) => {
    setBusy("add");
    setError("");
    try {
      const folderId = folder && folder !== "__new" ? Number(folder) : null;
      const r = await api.addFeed({
        ...request(overrideInput, viaBrowser),
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
  // a plugin that ran without an error can be empty for now (no assignments due yet) and fill up later
  const canSubscribe = !!preview && (preview.items.length > 0 || preview.kind === "plugin" || (preview.kind === "html" && !!rule)) && !preview.candidates.length;
  // nothing to subscribe to came out of the address: offer the other ways in
  const stuck = tab === "url" && (!!error || !!preview?.problem || (!!preview && !canSubscribe && !preview.candidates.length) || (preview?.kind === "html" && !rule));
  const rsshubBase = boot.data?.settings.rsshubBase || "";
  const draftPlugin = draft ? boot.data?.plugins.find((p) => p.id === draft.id) : undefined;

  const ways = tab === "url" && (preview || error) && (
    <div className="ways">
      {preview?.problem && <div className="callout warn">{preview.problem}</div>}
      {!!preview?.rsshub?.length && !draft && (
        <div className="way-group">
          <div className="way-head">
            RSSHub 可以订阅这个页面
            {(!rsshubBase || /rsshub\.app/.test(rsshubBase)) && <span className="muted">（公共的 rsshub.app 已限制访问，要在 设置 → RSSHub 填自建实例）</span>}
          </div>
          <div className="way-list">
            {preview.rsshub.slice(0, 8).map((m) => (
              <button
                key={m.route}
                type="button"
                className="way-item"
                onClick={() => {
                  setInput(`rsshub:/${m.route}`);
                  void runPreview({ input: `rsshub:/${m.route}`, kind: undefined, config: undefined });
                }}
              >
                <span className="t">{m.title}</span>
                <span className="d">{m.route}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {stuck && !draft && (
        <div className="way-buttons">
          {boot.data?.egoBrowser && !preview?.browser && (
            <button type="button" className="btn sm" disabled={!!busy} onClick={inBrowser} title="在你的浏览器里打开：过得了网站防护，也看得到脚本加载出来的内容">
              <Globe size={14} />
              用我的浏览器识别
            </button>
          )}
          {pageUrl && (
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => previewDraft({ id: "watch", params: { url: pageUrl } })} title="没有文章列表的页面：内容一变就记一篇">
              <Eye size={14} />
              监控网页变化
            </button>
          )}
          {errorCode === "bot_check" && !boot.data?.egoBrowser && <span className="muted">这个网站只让浏览器进。装上 ego 浏览器后，可以改用浏览器读取。</span>}
        </div>
      )}
      {draft && draftPlugin && (
        <div className="draft">
          <div className="callout plain">{draft.id === "json" ? "这是一个 JSON 接口。松果认出了下面这些字段，不对的可以改，再重新预览。" : "松果会定期打开这个网页，内容一变就记一篇，写明新增和删去了什么。只填选择器，就只看页面上的那一部分。"}</div>
          <div className="form-grid">
            {draftPlugin.params
              .filter((p) => !p.hidden)
              .map((p) => (
                <div key={p.key} className="form-row">
                  <label className="lbl">{p.label}</label>
                  <input className="field mono" placeholder={p.placeholder} value={draft.params[p.key] || ""} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, [p.key]: e.target.value } })} />
                </div>
              ))}
          </div>
          <button type="button" className="btn sm" style={{ marginTop: 10 }} disabled={!!busy} onClick={() => previewDraft(draft)}>
            {busy === "preview" ? <span className="spinner" /> : <Wand2 size={14} />}
            按这些字段重新预览
          </button>
        </div>
      )}
    </div>
  );

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
          {tab === "push" ? (
            pushed ? (
              <button
                className="btn primary"
                onClick={() => {
                  onClose();
                  navigate(`/feed/${pushed.id}`);
                }}
              >
                <Check size={16} />
                完成
              </button>
            ) : (
              <>
                <button className="btn ghost" onClick={onClose}>
                  取消
                </button>
                <button className="btn primary" disabled={!!busy} onClick={createPush}>
                  {busy === "add" ? <span className="spinner" /> : <Send size={16} />}
                  创建推送地址
                </button>
              </>
            )
          ) : (
            <>
              <button className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn primary" disabled={!canSubscribe || !!busy} onClick={() => subscribe()}>
                {busy === "add" ? <span className="spinner" /> : <Check size={16} />}
                订阅
              </button>
            </>
          )}
        </>
      }
    >
      <div style={{ marginBottom: 14 }}>
        <Segmented
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPreview(null);
            setDraft(null);
            setError("");
            setErrorCode("");
            // the plugin already chosen brings its own defaults (no full text for platforms behind a sign-in)
            if (t === "plugin") choosePlugin(pluginId);
            else setFullText("auto");
          }}
          options={[
            { value: "url", label: <><Globe size={14} />网址</> },
            { value: "rsshub", label: <><Sparkles size={14} />RSSHub</> },
            { value: "push", label: <><Send size={14} />推送</> },
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
      {tab === "url" && !preview && error && <div style={{ marginTop: 14 }}>{ways}</div>}
      {tab === "push" &&
        (pushed ? (
          <div className="form-grid">
            <div className="callout">推送地址建好了。往下面的地址发消息，就会出现在「{pushName.trim() || "推送"}」这个订阅里。以后在这个订阅的设置里也能找到它。</div>
            <PushInfo token={pushed.token} />
          </div>
        ) : (
          <div className="form-grid">
            <div className="callout plain">
              给一个来源一个专属的推送地址。iPhone 快捷指令、IFTTT / n8n、脚本、服务器告警、聊天机器人……把消息发到这个地址，就成了这个订阅里的文章。适合没法定期去取、只能由它主动发出来的消息。
            </div>
            <div className="form-row">
              <label className="lbl">名称</label>
              <input className="field" autoFocus placeholder="比如：手机通知、服务器告警、读书笔记" value={pushName} onChange={(e) => setPushName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && createPush()} />
            </div>
          </div>
        ))}
      {tab === "url" && !input.trim() && !preview && (
        <div className="picks">
          {PICKS.map((g) => (
            <section key={g.group}>
              <h4>{g.group}</h4>
              <div className="pick-grid">
                {g.items.map((x) => {
                  const have = subscribed.has(x.url);
                  return (
                    <button
                      key={x.url}
                      className="pick"
                      disabled={have || !!busy}
                      onClick={() => {
                        setInput(x.url);
                        void runPreview({ input: x.url });
                      }}
                    >
                      <b>
                        {x.title}
                        {have && <Check size={13} />}
                      </b>
                      <span>{have ? "已订阅" : x.note}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
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
            <select className="field" value={pluginId} onChange={(e) => choosePlugin(e.target.value)}>
              {[
                { label: "登录后订阅", list: boot.data.plugins.filter((p) => p.builtin && p.group === "account") },
                { label: "通用", list: boot.data.plugins.filter((p) => p.builtin && p.group === "general") },
                { label: "我的插件", list: boot.data.plugins.filter((p) => !p.builtin) },
              ]
                .filter((g) => g.list.length)
                .map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.list.map((p) => (
                      <option key={p.id} value={p.id} disabled={!!p.error}>
                        {p.name}
                        {p.error ? "（加载失败）" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
            {plugin?.description && <div className="callout plain">{plugin.description}</div>}
            {plugin?.account && <AccountPicker service={plugin.account} value={accountId} onChange={pickAccount} />}
            {!needsAccount &&
              plugin?.params.map((p) => (
                <div key={`${pluginId}:${p.key}`} className="form-row">
                  <label className="lbl">
                    {p.label}
                    {p.required || p.options?.length ? "" : "（可选）"}
                  </label>
                  <ParamField pluginId={pluginId} param={p} account={accountId} value={params[p.key] || ""} onChange={(v) => setParams((cur) => ({ ...cur, [p.key]: v }))} />
                </div>
              ))}
            <button className="btn" style={{ justifySelf: "start" }} disabled={!pluginId || needsAccount || !!busy} onClick={() => runPreview()}>
              {busy === "preview" ? <span className="spinner" /> : <Wand2 size={16} />}
              运行预览
            </button>
          </div>
        ) : (
          <div className="callout plain">还没有插件。把 TypeScript 文件放进项目的 plugins 目录就会出现在这里，可以让 Claude Code 帮你写。</div>
        ))}

      {preview && (
        <div style={{ marginTop: 18 }}>
          {ways}
          {preview.kind === "feed" && preview.candidates.length > 0 && !preview.items.length ? (
            <>
              <div className="callout" style={{ marginBottom: 10 }}>
                这个网页提供了 {preview.candidates.length} 个订阅源，选一个：
              </div>
              <div className="preview-list">
                {preview.candidates.map((c) => (
                  <button key={c.url} className="preview-item" style={{ width: "100%", textAlign: "left" }} onClick={() => subscribe(c.url, c.browser)}>
                    <span className="t">
                      {c.title || c.url}
                      {c.browser && <span className="badge" style={{ marginLeft: 8 }}>浏览器读取</span>}
                    </span>
                    <span className="d">{c.url}</span>
                  </button>
                ))}
              </div>
            </>
          ) : preview.problem && !preview.items.length && !rule && !draft ? null : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <KindBadge kind={preview.kind} plugin={draft?.id} browser={preview.browser} />
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
                        <button key={c.url} className="chip" onClick={() => subscribe(c.url, c.browser)}>
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
              <PreviewList items={preview.items} empty={preview.kind === "plugin" ? "现在还没有内容。订阅之后，有新的会自动出现。" : undefined} />
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
