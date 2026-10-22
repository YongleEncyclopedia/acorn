import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LogOut, Menu as MenuIcon, Plus, Rss, ScrollText, Send, Smartphone, Trash2 } from "lucide-react";
import { Layout } from "./Layout.tsx";
import { FontPicker, ThemePicker, usePrefs } from "./ReaderPrefs.tsx";
import { api } from "../lib/api.ts";
import { keys, useBootstrap } from "../lib/queries.ts";
import { bytes, fullDate, relTime } from "../lib/format.ts";
import { readerStyle } from "../lib/theme.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { Segmented, Slider, Switch } from "../components/Controls.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Seal } from "../components/Seal.tsx";
import { PhoneLogin } from "../components/PhoneLogin.tsx";
import type { Bootstrap, Settings, TranslateSettings } from "../../../src/shared/types.ts";
import { TARGET_LANGS } from "../../../src/shared/translate.ts";

const SAMPLE =
  "松鼠秋天会把橡果一颗颗埋进土里，留到冬天慢慢吃。它记不住每一处，于是总有几颗在春天发了芽。读东西也是这样：先收好，再慢慢消化，偶尔会长出新的东西。";

function copy(text: string, msg = "已复制") {
  navigator.clipboard?.writeText(text).then(() => toast(msg));
}

function CodeLine({ text }: { text: string }) {
  return (
    <button className="code-line" onClick={() => copy(text)} title="点击复制" style={{ width: "100%", textAlign: "left" }}>
      <span>{text}</span>
      <Copy size={13} />
    </button>
  );
}

function useSettings(): [Settings | undefined, (patch: Partial<Settings>) => Promise<void>] {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const save = async (patch: Partial<Settings>) => {
    try {
      const next = await api.patchSettings(patch);
      qc.setQueryData<Bootstrap>(keys.bootstrap, (b) => (b ? { ...b, settings: next } : b));
    } catch (e) {
      toastError(e);
    }
  };
  return [boot.data?.settings, save];
}

function Tokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.tokens });
  const [fresh, setFresh] = useState<string | null>(null);
  const create = async () => {
    const name = window.prompt("这个令牌给谁用？", "我的脚本");
    if (!name) return;
    try {
      const r = await api.createToken(name);
      setFresh(r.token);
      qc.invalidateQueries({ queryKey: ["tokens"] });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      {(tokens.data || []).map((t) => (
        <div key={t.id} className="setting-row">
          <div className="txt">
            <b>{t.name}</b>
            <span>
              创建于 {fullDate(t.createdAt)}
              {t.lastUsedAt ? ` · ${relTime(t.lastUsedAt)}用过` : " · 还没用过"}
            </span>
          </div>
          <button
            className="icon-btn sm"
            aria-label="删除令牌"
            onClick={async () => {
              if (!window.confirm(`删除令牌「${t.name}」？用它的程序会立刻失去访问权限。`)) return;
              await api.deleteToken(t.id).catch(toastError);
              qc.invalidateQueries({ queryKey: ["tokens"] });
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="setting-row">
        <div className="txt">
          <span>令牌用于 Agent、脚本和第三方阅读器。命令行与 MCP 会自动使用 data/.cli-token，不需要手动创建。</span>
        </div>
        <button className="btn sm" onClick={create}>
          <Plus size={14} />
          新令牌
        </button>
      </div>
      {fresh && (
        <Dialog title="新令牌" size="sm" onClose={() => setFresh(null)}>
          <div className="form-grid">
            <div className="callout">只显示这一次，请现在复制保存。</div>
            <CodeLine text={fresh} />
          </div>
        </Dialog>
      )}
    </>
  );
}

const ENGINES: { id: string; label: string; provider: TranslateSettings["provider"]; baseUrl: string; model: string; hint: string }[] = [
  { id: "ollama", label: "本机 Ollama", provider: "ollama", baseUrl: "", model: "qwen3:8b", hint: "免费、离线，文章不出这台电脑。先装 Ollama 并下载模型，例如 ollama pull qwen3:8b" },
  { id: "deepseek", label: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", hint: "便宜、中文好。API Key 在 platform.deepseek.com 申请" },
  { id: "qwen", label: "通义千问", provider: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hint: "阿里云百炼的 OpenAI 兼容接口" },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "", hint: "填你账号可用的模型名" },
  { id: "claude", label: "Claude", provider: "anthropic", baseUrl: "", model: "claude-haiku-5-5", hint: "Anthropic 的 Messages API" },
  { id: "custom", label: "其他 OpenAI 兼容接口", provider: "openai", baseUrl: "", model: "", hint: "OpenRouter、硅基流动、LM Studio 等，填它们的 /v1 地址" },
];

const engineOf = (t: TranslateSettings) =>
  ENGINES.find((e) => e.provider === t.provider && e.id !== "custom" && (e.baseUrl === t.baseUrl || (!e.baseUrl && !t.baseUrl))) || ENGINES.find((e) => e.id === "custom")!;

/** Machine translation: a local model through Ollama, or a cloud API. */
function Translate({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const cfg = s.translate;
  const [draft, setDraft] = useState<Pick<TranslateSettings, "provider" | "baseUrl" | "model" | "apiKey"> | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text?: string; error?: string; ms: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const cur = { ...cfg, ...(draft || {}) };
  const engine = engineOf(cur);
  const models = useQuery({ queryKey: ["translate-models", cfg.provider, cfg.baseUrl, cfg.apiKey], queryFn: api.translateModels, staleTime: 60_000 });
  const edit = (patch: Partial<TranslateSettings>) => {
    setDraft({ provider: cur.provider, baseUrl: cur.baseUrl, model: cur.model, apiKey: cur.apiKey, ...patch });
    setTest(null);
  };
  const pick = (id: string) => {
    const e = ENGINES.find((x) => x.id === id)!;
    edit({ provider: e.provider, baseUrl: e.baseUrl, model: e.model, apiKey: e.provider === cfg.provider && e.baseUrl === cfg.baseUrl ? cfg.apiKey : "" });
  };
  const runTest = async () => {
    setTesting(true);
    try {
      if (draft) {
        await save({ translate: { ...cfg, ...draft } });
        setDraft(null);
      }
      setTest(await api.translateTest());
    } catch (e) {
      toastError(e);
    } finally {
      setTesting(false);
    }
  };
  return (
    <section className="settings-section" id="translate">
      <h2>翻译与要点</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>模型</b>
            <span>翻译和「要点」都用这个模型。{engine.hint}</span>
          </div>
          <select className="field" value={engine.id} onChange={(e) => pick(e.target.value)}>
            {ENGINES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          {(engine.id === "custom" || engine.provider === "ollama") && (
            <input className="field mono" placeholder={engine.provider === "ollama" ? "http://127.0.0.1:11434" : "https://…/v1"} value={cur.baseUrl} onChange={(e) => edit({ baseUrl: e.target.value })} />
          )}
          <input className="field mono" list="translate-models" placeholder="模型名" value={cur.model} onChange={(e) => edit({ model: e.target.value })} />
          <datalist id="translate-models">
            {(models.data?.models || []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {cur.provider !== "ollama" && (
            <input className="field mono" type="password" autoComplete="off" placeholder="API Key" value={cur.apiKey} onChange={(e) => edit({ apiKey: e.target.value })} />
          )}
          <div className="bridge-status">
            {test ? (
              test.ok ? (
                <span>
                  {(test.ms / 1000).toFixed(1)} 秒 · {test.text}
                </span>
              ) : (
                <span className="bad">{test.error}</span>
              )
            ) : (
              <span className="muted">{draft ? "改动还没保存" : "保存后可以测试一下"}</span>
            )}
            <span className="grow" />
            <button className="btn sm ghost" disabled={testing} onClick={runTest}>
              {testing ? "测试中…" : "测试"}
            </button>
            <button className="btn sm" disabled={!draft} onClick={() => save({ translate: { ...cfg, ...draft! } }).then(() => (setDraft(null), toast("已保存")))}>
              保存
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>译成</b>
          </div>
          <select className="field" style={{ width: 140 }} value={cfg.targetLang} onChange={(e) => save({ translate: { ...cfg, targetLang: e.target.value } })}>
            {TARGET_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>外文文章自动翻译</b>
            <span>打开外文文章就开始翻译；关掉时点阅读栏的「译」按钮（快捷键 T）</span>
          </div>
          <Switch checked={cfg.auto} onChange={(v) => save({ translate: { ...cfg, auto: v } })} />
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>翻译列表里的外文标题</b>
            <span>标题下面多一行译文，扫一眼就知道值不值得点开；新文章刷新时就先译好</span>
          </div>
          <Switch checked={cfg.titles} onChange={(v) => save({ translate: { ...cfg, titles: v } })} />
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>显示方式</b>
          </div>
          <Segmented
            value={cfg.display}
            options={[
              { value: "bilingual", label: "双语对照" },
              { value: "only", label: "只看译文" },
            ]}
            onChange={(v) => save({ translate: { ...cfg, display: v } })}
          />
        </div>
      </div>
    </section>
  );
}

/** WeChat Official Accounts arrive through we-mp-rss; Acorn mirrors its account list as feeds. */
function WechatBridge({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const qc = useQueryClient();
  const cfg = s.wechatBridge;
  const [url, setUrl] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const status = useQuery({ queryKey: ["wechat-bridge", cfg.url], queryFn: api.wechatBridge, enabled: !!cfg.url, retry: false });
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.wechatSync();
      toast(r.added.length ? `新订阅 ${r.added.length} 个公众号` : "没有新的公众号");
      if (r.failed.length) toastError(new Error(`${r.failed.length} 个订阅失败：${r.failed[0].title}（${r.failed[0].error}）`));
      qc.invalidateQueries({ queryKey: ["wechat-bridge"] });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (err) {
      toastError(err);
    } finally {
      setSyncing(false);
    }
  };
  const saveUrl = async () => {
    await save({ wechatBridge: { ...cfg, url: url || "" } });
    setUrl(null);
    if (url) await sync();
  };
  const accounts = status.data?.accounts || [];
  const synced = accounts.filter((a) => a.feedId).length;
  const last = status.data?.lastEntryAt;
  // we-mp-rss's WeChat logins lapse every few days and the accounts then go quiet without an error anywhere.
  const stale = !!last && accounts.length > 0 && Date.now() - last > 36 * 3_600_000;
  return (
    <section className="settings-section">
      <h2>微信公众号</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>we-mp-rss 地址</b>
            <span>公众号经 we-mp-rss 转成订阅源：在它的后台扫码授权、按名字添加公众号，松果每 10 分钟把新加的公众号自动订阅进来，正文直接来自订阅源，不会撞上微信的验证页。</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field mono" placeholder="http://127.0.0.1:8001" value={url ?? cfg.url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" disabled={url === null} onClick={() => saveUrl().catch(toastError)}>
              保存
            </button>
          </div>
          {stale && (
            <div className="callout warn">
              公众号已经 {Math.round((Date.now() - last!) / 3_600_000)} 小时没有新文章了。多半是 we-mp-rss 里的微信读书或公众平台登录过期了：打开 we-mp-rss，在「授权管理」里重新扫码。
            </div>
          )}
          {cfg.url && (
            <div className="bridge-status">
              {status.isLoading ? (
                <span className="muted">正在连接…</span>
              ) : status.isError ? (
                <span className="bad">连不上 we-mp-rss：{(status.error as Error).message}</span>
              ) : (
                <span>
                  已连接 · {accounts.length} 个公众号{accounts.length ? `，${synced} 个已在松果` : "，先去 we-mp-rss 里添加"}
                  {last ? ` · 最近一篇 ${relTime(last)}` : ""}
                </span>
              )}
              <span className="grow" />
              <a className="btn sm ghost" href={cfg.url} target="_blank" rel="noreferrer">
                打开 we-mp-rss
              </a>
              <button className="btn sm" disabled={syncing || status.isError} onClick={sync}>
                {syncing ? "同步中…" : "立即同步"}
              </button>
            </div>
          )}
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>放进文件夹</b>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field" style={{ width: 140 }} value={folder ?? cfg.folder} onChange={(e) => setFolder(e.target.value)} />
            <button className="btn" disabled={folder === null} onClick={() => save({ wechatBridge: { ...cfg, folder: folder || "" } }).then(() => (setFolder(null), toast("已保存")))}>
              保存
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>新文章自动入藏</b>
            <span>公众号文章最容易消失：文字和图片一到就存进本地存档。只影响之后同步进来的公众号</span>
          </div>
          <Switch checked={cfg.autoArchive} onChange={(v) => save({ wechatBridge: { ...cfg, autoArchive: v } })} />
        </div>
      </div>
    </section>
  );
}

function Logs({ onClose }: { onClose: () => void }) {
  const logs = useQuery({ queryKey: ["logs"], queryFn: api.logs, refetchInterval: 4000 });
  return (
    <Dialog title="运行日志" size="lg" onClose={onClose}>
      <div className="code-line" style={{ display: "block", whiteSpace: "pre-wrap", maxHeight: "60vh", overflowY: "auto", lineHeight: 1.6 }}>
        {(logs.data || [])
          .slice()
          .reverse()
          .map((l, i) => (
            <div key={i} style={{ color: l.level === "error" ? "var(--danger)" : l.level === "warn" ? "var(--warn)" : "inherit" }}>
              {new Date(l.at).toLocaleTimeString("zh-CN", { hour12: false })} [{l.scope}] {l.msg}
            </div>
          ))}
      </div>
    </Dialog>
  );
}

export function SettingsPage() {
  const boot = useBootstrap();
  const qc = useQueryClient();
  const [s, save] = useSettings();
  const [prefs, setPrefs] = usePrefs();
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const [rsshub, setRsshub] = useState<string | null>(null);
  const [rsshubKey, setRsshubKey] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [showLogs, setShowLogs] = useState(false);
  const [digestPreview, setDigestPreview] = useState<string | null>(null);
  const [phoneLogin, setPhoneLogin] = useState(false);
  const origin = window.location.origin;
  // Readers and shortcuts run on other devices: show an address they can reach, not this browser's localhost.
  const addrs = useQuery({ queryKey: ["addresses"], queryFn: api.addresses, staleTime: 60_000 });
  const deviceOrigin = addrs.data?.origins[0]?.origin || origin;
  const bookmarklet = `javascript:(()=>{window.open('${origin}/capture?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title))})()`;
  const ready = !!s && !!boot.data;
  useEffect(() => {
    if (ready && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [ready]);
  if (!s || !boot.data) return null;

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
              <h1>设置</h1>
              <div className="lede">所有设置保存在你自己的电脑上，在每台设备上都一样。</div>
            </div>
            <div className="actions">
              <Link href="/sources" className="btn">
                <Rss size={16} />
                订阅管理
              </Link>
            </div>
          </div>

          <section className="settings-section">
            <h2>阅读外观</h2>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="prefs" style={{ width: "100%", padding: 0 }}>
                  <ThemePicker value={prefs.theme} onChange={(theme) => setPrefs({ theme })} />
                  <FontPicker value={prefs.font} onChange={(font) => setPrefs({ font })} />
                </div>
              </div>
              <div className="setting-row wrap">
                <div className="txt">
                  <b>字号 {prefs.fontSize}</b>
                </div>
                <div style={{ width: 220 }}>
                  <Slider value={prefs.fontSize} min={14} max={26} step={1} onChange={(fontSize) => setPrefs({ fontSize })} />
                </div>
              </div>
              <div className="setting-row wrap">
                <div className="txt">
                  <b>行距 {prefs.lineHeight.toFixed(2)}</b>
                </div>
                <div style={{ width: 220 }}>
                  <Slider value={prefs.lineHeight} min={1.4} max={2.3} step={0.05} onChange={(lineHeight) => setPrefs({ lineHeight })} />
                </div>
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>版心宽度</b>
                </div>
                <Segmented
                  value={prefs.width}
                  onChange={(width) => setPrefs({ width })}
                  options={[
                    { value: "narrow", label: "窄" },
                    { value: "medium", label: "适中" },
                    { value: "wide", label: "宽" },
                  ]}
                />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>首行缩进两字</b>
                  <span>传统中文排版</span>
                </div>
                <Switch checked={prefs.indent} onChange={(indent) => setPrefs({ indent })} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>两端对齐</b>
                </div>
                <Switch checked={prefs.justify} onChange={(justify) => setPrefs({ justify })} />
              </div>
              <div className="setting-row stack" style={{ background: "var(--bg-reader)", borderRadius: "0 0 var(--radius-lg) var(--radius-lg)" }}>
                <div style={{ ...readerStyle(prefs), padding: "6px 4px" }}>
                  <div className="article" data-justify={prefs.justify} data-indent={prefs.indent} style={{ maxWidth: "100%" }}>
                    <p>{SAMPLE}</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>阅读习惯</h2>
            <div className="settings-card">
              <div className="setting-row">
                <div className="txt">
                  <b>打开即标为已读</b>
                </div>
                <Switch checked={s.markReadOnOpen} onChange={(v) => save({ markReadOnOpen: v })} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>加入稍后读时自动入藏</b>
                  <span>松鼠模式：喜欢的就先藏起来</span>
                </div>
                <Switch checked={s.archiveOnStar} onChange={(v) => save({ archiveOnStar: v })} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>批注时自动入藏</b>
                </div>
                <Switch checked={s.archiveOnHighlight} onChange={(v) => save({ archiveOnHighlight: v })} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>默认更新频率</b>
                  <span>单个订阅源可以单独设置</span>
                </div>
                <select className="field" style={{ width: 120 }} value={s.defaultInterval} onChange={(e) => save({ defaultInterval: Number(e.target.value) })}>
                  {[10, 15, 30, 60, 120, 240].map((m) => (
                    <option key={m} value={m}>
                      {m < 60 ? `${m} 分钟` : `${m / 60} 小时`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>存档巡检</b>
                  <span>定期回访原文：被删了就标记出来，被改了就另存一个版本</span>
                </div>
                <select className="field" style={{ width: 120 }} value={s.recheckDays} onChange={(e) => save({ recheckDays: Number(e.target.value) })}>
                  <option value={0}>关闭</option>
                  {[1, 3, 7, 14, 30].map((d) => (
                    <option key={d} value={d}>
                      每 {d} 天
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>旧文章清理</b>
                  <span>只清理已读、没标记、没入藏、没批注的文章</span>
                </div>
                <select className="field" style={{ width: 120 }} value={s.retentionDays} onChange={(e) => save({ retentionDays: Number(e.target.value) })}>
                  <option value={0}>永不清理</option>
                  {[30, 90, 180, 365].map((d) => (
                    <option key={d} value={d}>
                      {d} 天后
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>RSSHub</h2>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="txt">
                  <b>实例地址</b>
                  <span>公共实例 rsshub.app 时常被限流。自建一个（比如 Docker 跑在这台电脑上）最稳定，也能填你自己的 B 站、微博 Cookie。</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="field mono" placeholder="https://rsshub.app" value={rsshub ?? s.rsshubBase} onChange={(e) => setRsshub(e.target.value)} />
                  <button className="btn" disabled={rsshub === null} onClick={() => save({ rsshubBase: rsshub || "" }).then(() => (setRsshub(null), toast("已保存")))}>
                    保存
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="field mono" placeholder="访问密钥 ACCESS_KEY（可选）" value={rsshubKey ?? s.rsshubKey} onChange={(e) => setRsshubKey(e.target.value)} />
                  <button className="btn" disabled={rsshubKey === null} onClick={() => save({ rsshubKey: rsshubKey || "" }).then(() => (setRsshubKey(null), toast("已保存")))}>
                    保存
                  </button>
                </div>
              </div>
            </div>
          </section>

          <Translate s={s} save={save} />

          <WechatBridge s={s} save={save} />

          <section className="settings-section">
            <h2>多设备</h2>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="txt">
                  <b>在手机和平板上用</b>
                  <span>扫一个二维码就能在手机上打开松果，不用输地址和密码；再「添加到主屏幕」，就是一个 App。出门在外推荐装 Tailscale，不用把松果暴露到公网。</span>
                </div>
                <div>
                  <button className="btn primary" onClick={() => setPhoneLogin(true)}>
                    <Smartphone size={16} />
                    扫码在手机上登录
                  </button>
                </div>
              </div>
              <div className="setting-row stack">
                <div className="txt">
                  <b>用 Reeder、NetNewsWire、Read You 等阅读器</b>
                  <span>账号类型选 FreshRSS 或 Google Reader API。服务器地址填下面这个，用户名随意，密码填松果密码。在阅读器里加星标，松果会自动入藏。</span>
                </div>
                <CodeLine text={deviceOrigin} />
              </div>
              <div className="setting-row stack">
                <div className="txt">
                  <b>书签小工具</b>
                  <span>把下面的按钮拖到浏览器书签栏。在任何网页上点一下，就能把它收进松果。</span>
                </div>
                <div>
                  <a className="btn" href={bookmarklet} onClick={(e) => (e.preventDefault(), toast("请把它拖到书签栏"))}>
                    <Seal size="xs" />
                    收进松果
                  </a>
                </div>
              </div>
              <div className="setting-row stack">
                <div className="txt">
                  <b>iPhone 分享菜单</b>
                  <span>在「快捷指令」里新建：接收「URL」→「打开 URL」，地址填下面这行，末尾接上快捷指令输入。安卓手机把松果添加到主屏幕后，可以直接在分享菜单里选它。</span>
                </div>
                <CodeLine text={`${deviceOrigin}/capture?url=`} />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>Agent 与 API 令牌</h2>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="txt">
                  <b>让 Claude Code / Hermes 接管</b>
                  <span>项目根目录的 AGENTS.md 写清了一切。也可以把松果加为 MCP 服务器：</span>
                </div>
                <CodeLine text={`claude mcp add acorn -- node --disable-warning=ExperimentalWarning ${boot.data.dataDir.replace(/\/data$/, "")}/src/mcp/server.ts`} />
              </div>
              <Tokens />
            </div>
          </section>

          <section className="settings-section">
            <h2>每日摘要 · Telegram</h2>
            <div className="settings-card">
              {boot.data.telegram ? (
                <>
                  <div className="setting-row">
                    <div className="txt">
                      <b>每天推送摘要</b>
                      <span>新到的文章、读到一半的、以及原文刚消失的存档</span>
                    </div>
                    <Switch checked={s.digest.enabled} onChange={(v) => save({ digest: { ...s.digest, enabled: v } })} />
                  </div>
                  <div className="setting-row">
                    <div className="txt">
                      <b>时间（cron）</b>
                      <span>默认每天早上 8 点：0 8 * * *</span>
                    </div>
                    <input className="field mono" style={{ width: 140 }} defaultValue={s.digest.cron} onBlur={(e) => e.target.value !== s.digest.cron && save({ digest: { ...s.digest, cron: e.target.value } })} />
                  </div>
                  <div className="setting-row stack">
                    <div className="txt">
                      <b>只看这些分组</b>
                      <span>不选就是全部</span>
                    </div>
                    <div className="toolbar-row" style={{ marginBottom: 0 }}>
                      {boot.data.folders.map((f) => {
                        const on = s.digest.folders.includes(f.id);
                        return (
                          <button key={f.id} className="chip" aria-pressed={on} onClick={() => save({ digest: { ...s.digest, folders: on ? s.digest.folders.filter((x) => x !== f.id) : [...s.digest.folders, f.id] } })}>
                            {f.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="txt" />
                    <button className="btn sm ghost" onClick={() => api.digestPreview().then((r) => setDigestPreview(r.html), toastError)}>
                      预览
                    </button>
                    <button className="btn sm" onClick={() => api.digestSend().then(() => toast("已发送"), toastError)}>
                      <Send size={14} />
                      现在发一条
                    </button>
                  </div>
                </>
              ) : (
                <div className="setting-row stack">
                  <div className="txt">
                    <span>在项目根目录的 .env 里填上 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID，重启松果后就能在这里打开每日摘要。热榜类的实时告警交给 TrendRadar 推到同一个机器人即可。</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h2>数据</h2>
            <div className="stat-row">
              <div className="stat">
                <div className="v">{stats.data?.entries ?? "–"}</div>
                <div className="k">篇文章</div>
              </div>
              <div className="stat">
                <div className="v">{stats.data?.archives ?? "–"}</div>
                <div className="k">份存档 · {stats.data?.snapshots ?? 0} 个版本</div>
              </div>
              <div className="stat">
                <div className="v">{stats.data ? bytes(stats.data.archiveBytes) : "–"}</div>
                <div className="k">存档占用</div>
              </div>
              <div className="stat">
                <div className="v">{stats.data ? bytes(stats.data.dbBytes + stats.data.cacheBytes) : "–"}</div>
                <div className="k">数据库与缓存</div>
              </div>
            </div>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="txt">
                  <b>数据目录</b>
                  <span>数据库、存档、缓存都在这里。备份它就备份了一切；存档是普通文件，不依赖松果也能打开。</span>
                </div>
                <CodeLine text={boot.data.dataDir} />
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>从别处搬家</b>
                  <span>浏览器书签、Pocket、Instapaper、Raindrop、Readwise 的导出文件，里面的链接一次全部入藏；原文已经消失的，从 Internet Archive 找回。</span>
                </div>
                <Link href="/archive?movein=1" className="btn sm">
                  开始搬家
                </Link>
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>运行日志</b>
                  <span>
                    后台任务：{stats.data?.jobs.running ?? 0} 个进行中，{stats.data?.jobs.queued ?? 0} 个排队
                  </span>
                </div>
                <button className="btn sm" onClick={() => setShowLogs(true)}>
                  <ScrollText size={14} />
                  查看
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>账户</h2>
            <div className="settings-card">
              <div className="setting-row stack">
                <div className="txt">
                  <b>修改密码</b>
                  <span>修改后其他设备需要重新登录</span>
                </div>
                <div className="two-col">
                  <input className="field" type="password" placeholder="当前密码" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                  <input className="field" type="password" placeholder="新密码（至少 6 位）" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                </div>
                <div>
                  <button
                    className="btn sm"
                    disabled={!pw.current || pw.next.length < 6}
                    onClick={() =>
                      api.password(pw.current, pw.next).then(() => {
                        toast("密码已修改");
                        setPw({ current: "", next: "" });
                      }, toastError)
                    }
                  >
                    <KeyRound size={14} />
                    修改
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="txt">
                  <b>退出登录</b>
                </div>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await api.logout();
                    qc.clear();
                    window.location.href = "/";
                  }}
                >
                  <LogOut size={14} />
                  退出
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>快捷键</h2>
            <div className="settings-card">
              {[
                ["J / K", "下一篇 / 上一篇"],
                ["S", "稍后读（并自动入藏）"],
                ["A", "入藏"],
                ["M", "标为已读 / 未读"],
                ["F", "抓取全文 / 切换原始内容"],
                ["H", "本文批注"],
                ["T", "翻译 / 关闭翻译"],
                ["I", "要点（AI 提炼）"],
                ["V", "打开原文"],
                ["R", "刷新"],
                ["Shift + A", "全部标为已读"],
                ["⌘K 或 /", "搜索"],
                ["G 然后 U / T / S / A / N", "去未读 / 今日 / 稍后读 / 藏 / 批注"],
              ].map(([k, v]) => (
                <div key={k} className="setting-row" style={{ minHeight: 44, padding: "8px 16px" }}>
                  <div className="txt">
                    <span style={{ color: "var(--ink)", marginTop: 0 }}>{v}</span>
                  </div>
                  <kbd>{k}</kbd>
                </div>
              ))}
            </div>
          </section>
          <p className="muted" style={{ textAlign: "center", fontSize: 12.5, marginTop: 24 }}>
            松果 Acorn {boot.data.version} · 完全属于你
          </p>
        </div>
      </main>
      {showLogs && <Logs onClose={() => setShowLogs(false)} />}
      {phoneLogin && <PhoneLogin onClose={() => setPhoneLogin(false)} />}
      {digestPreview && (
        <Dialog title="摘要预览" onClose={() => setDigestPreview(null)}>
          <div className="code-line" style={{ display: "block", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
            {digestPreview.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")}
          </div>
        </Dialog>
      )}
    </Layout>
  );
}
