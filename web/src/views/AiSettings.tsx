/**
 * 设置 → 翻译与要点: the AI service behind translation and key points. Everything here is a draft until 保存:
 * the model list, each model's capabilities and a test sentence all come from what is typed, before anything is
 * applied — the way Hermes Agent's `hermes model` sets a provider up.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, RefreshCw, Search } from "lucide-react";
import { api, type AiDraft } from "../lib/api.ts";
import { keys } from "../lib/queries.ts";
import { toast, toastError } from "../lib/store.ts";
import { focusables } from "../lib/layers.ts";
import { Segmented, Switch } from "../components/Controls.tsx";
import { Popover, useAnchor } from "../components/Popover.tsx";
import type { Bootstrap, ModelInfo, ModelList, ModelTest, ReasoningChoice, Settings, TranslateSettings } from "../../../src/shared/types.ts";
import { canDisable, CHOICE_LABELS, contextFor, describePlan, formatPrice, formatTokens, isMaskedKey, keyTarget, parseTokens, PRESET_GROUPS, PRESETS, presetById, REASONING_CHOICES, reasoningChoices, type ContextWindow, type Preset } from "../../../src/shared/ai.ts";
import { TARGET_LANGS } from "../../../src/shared/translate.ts";

type Draft = Required<AiDraft>;
const KEYS = ["provider", "preset", "baseUrl", "apiKey", "model", "reasoning", "contextLength", "extraBody"] as const;
const draftOf = (t: TranslateSettings): Draft => ({ provider: t.provider, preset: t.preset, baseUrl: t.baseUrl, apiKey: t.apiKey, model: t.model, reasoning: t.reasoning, contextLength: t.contextLength, extraBody: t.extraBody });
const same = (a: Draft, b: Draft) => KEYS.every((k) => a[k] === b[k]);

/**
 * The value once it has stopped changing for a moment: typing a key should not ask the service at every letter.
 * A new `scope` (another service picked) takes effect at once: nothing is being typed, and the old service's
 * answers would be wrong for the new one.
 */
function useSettled<T>(value: T, scope: string, ms = 600): T {
  const [settled, setSettled] = useState(value);
  const [settledScope, setSettledScope] = useState(scope);
  const key = JSON.stringify(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  if (scope !== settledScope) {
    setSettledScope(scope);
    setSettled(value);
    return value;
  }
  return settled;
}

const isJsonObject = (text: string): boolean => {
  if (!text.trim()) return true;
  try {
    const v = JSON.parse(text);
    return !!v && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
};

/** The short facts shown with a model. */
function facts(m: ModelInfo): string[] {
  const reasoning = m.reasoning === false ? "不推理" : m.reasoning ? (canDisable(m.reasoning) ? "可关推理" : "一直推理") : "";
  return [m.context ? `上下文 ${formatTokens(m.context)}` : "", reasoning, formatPrice(m.price), m.detail || ""].filter(Boolean);
}

/** Where a context window figure came from, in a few words. */
function contextNote(ctx: ContextWindow, preset: Preset, provider: TranslateSettings["provider"]): string {
  // exact figures: "128K" can mean 128,000 or 131,072
  if (ctx.source === "pinned") return ctx.max && ctx.tokens > ctx.max ? `填的是 ${ctx.tokens.toLocaleString()} token，超过了这个模型的 ${ctx.max.toLocaleString()}，服务可能会报错。` : "已手动设定。";
  if (provider === "ollama") return `本机 Ollama 默认按 8K 运行，省显存${ctx.max ? `；这个模型最多支持 ${formatTokens(ctx.max)}` : ""}。想让要点读完长文，可以填 32K。`;
  if (ctx.source === "service") return `由 ${preset.label} 提供。`;
  if (ctx.source === "catalog") return "来自 models.dev 模型目录。";
  return "没查到这个模型的上下文，按 128K 估算；知道的话可以手动填写。";
}

/** The searchable list of a service's models. */
function ModelPicker(props: { anchor: HTMLElement | null; onClose: () => void; list: ModelList | undefined; loading: boolean; value: string; onPick: (m: ModelInfo) => void; onRefresh: () => void }) {
  const { anchor, onClose, list, loading, value, onPick, onRefresh } = props;
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const models = list?.models ?? [];
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (n ? models.filter((m) => m.id.toLowerCase().includes(n) || !!m.name?.toLowerCase().includes(n)) : models).slice(0, 400);
  }, [models, q]);
  // a search starts at the top of what it found; the list opens on the model in use
  useEffect(() => {
    box.current?.scrollTo({ top: 0 });
  }, [q]);
  useEffect(() => {
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [list]);
  const step = (e: React.KeyboardEvent, from: HTMLElement | null) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = box.current ? focusables(box.current) : [];
    const at = from ? items.indexOf(from) : -1;
    const next = e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : at - 1;
    if (next < 0) (box.current?.parentElement?.querySelector("input") as HTMLInputElement | null)?.focus();
    else items[next]?.focus();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" className="model-picker" label="选择模型">
      <div className="mp-search">
        <Search size={15} />
        <input
          autoFocus
          placeholder={models.length ? `在 ${models.length} 个模型里搜索` : "搜索模型"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && shown[0]) {
              // without this the same keypress lands on the 选择 button, which has the focus back by then, and reopens the list
              e.preventDefault();
              onPick(shown[0]);
            } else step(e, null);
          }}
        />
        <button type="button" className="icon-btn sm" onClick={onRefresh} title="重新获取" aria-label="重新获取模型列表">
          {loading ? <span className="spinner" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {list?.error && (
        <div className="mp-note">
          {list.error}
          {list.source === "catalog" ? "。下面是 models.dev 目录里这个服务的模型。" : "。"}
        </div>
      )}
      <div ref={box} className="mp-list scroll" role="listbox" aria-label="模型">
        {shown.map((m) => (
          <button key={m.id} type="button" role="option" aria-selected={m.id === value} className="mp-item" onClick={() => onPick(m)} onKeyDown={(e) => step(e, e.currentTarget)}>
            <span className="mp-main">
              <span className="mp-id">{m.id}</span>
              {m.name && <span className="mp-name">{m.name}</span>}
            </span>
            <span className="mp-facts">
              {facts(m).map((f) => (
                <span key={f}>{f}</span>
              ))}
            </span>
          </button>
        ))}
        {!shown.length && <div className="mp-empty">{loading ? "正在获取模型列表…" : q ? `没有找到「${q}」` : "这个服务没有列出模型，可以直接填写模型名"}</div>}
      </div>
      {models.some((m) => m.price) && <div className="mp-foot">价格是每百万 token 的输入 / 输出，美元</div>}
    </Popover>
  );
}

/** The context window: empty for "detect it", or a number like 32768, 32K, 1M. */
function ContextField({ value, auto, onChange }: { value: number; auto: ContextWindow; onChange: (v: number) => void }) {
  const [text, setText] = useState(value ? formatTokens(value) : "");
  useEffect(() => setText(value ? formatTokens(value) : ""), [value]);
  const commit = () => {
    const t = text.trim();
    if (!t) return onChange(0);
    const n = parseTokens(t);
    if (n >= 512) return onChange(n);
    toast("上下文长度写成 32768、32K 或 1M 这样");
    setText(value ? formatTokens(value) : "");
  };
  return (
    <input
      id="ai-ctx"
      className="field mono ai-ctx"
      inputMode="text"
      placeholder={`自动：${formatTokens(auto.tokens)}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      spellCheck={false}
    />
  );
}

/** The model field: typed freely, or picked from the service's list. */
function useModels(draft: Draft, preset: Preset) {
  const conn = useSettled({ provider: draft.provider, preset: draft.preset, baseUrl: draft.baseUrl, apiKey: draft.apiKey }, `${draft.provider}|${draft.preset}`);
  // OpenRouter lists its models without a key; the others need one first
  const reachable = !preset.needsKey || !!conn.apiKey || preset.id === "openrouter";
  const list = useQuery({
    queryKey: ["ai-models", conn.provider, conn.preset, conn.baseUrl, conn.apiKey],
    queryFn: () => api.aiModels(conn),
    enabled: reachable,
    staleTime: 10 * 60_000,
    retry: false,
  });
  // the list stays on screen while it is fetched again
  return { list, reachable, refresh: () => void list.refetch() };
}

export function AiSettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const qc = useQueryClient();
  const cfg = s.translate;
  const saved = draftOf(cfg);
  const [draft, setDraft] = useState<Draft>(saved);
  const [test, setTest] = useState<ModelTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(!!cfg.extraBody);
  const picker = useAnchor();

  // Settings saved elsewhere (another device) show up here, unless something is being edited.
  const savedKey = JSON.stringify(saved);
  const lastSaved = useRef(savedKey);
  useEffect(() => {
    if (lastSaved.current === savedKey) return;
    const before = JSON.parse(lastSaved.current) as Draft;
    lastSaved.current = savedKey;
    setDraft((d) => (same(d, before) ? (JSON.parse(savedKey) as Draft) : d));
  }, [savedKey]);

  const preset = presetById(draft.preset) ?? PRESETS[0];
  const { list, reachable, refresh } = useModels(draft, preset);
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTest(null);
  };

  const choosePreset = (id: string) => {
    const p = presetById(id) ?? PRESETS[0];
    // back to the saved service: its key, model and choices come back with it
    const back = id === cfg.preset;
    edit({
      preset: p.id,
      provider: p.protocol,
      baseUrl: back ? cfg.baseUrl : p.editableUrl ? p.baseUrl : "",
      apiKey: back ? cfg.apiKey : "",
      model: back ? cfg.model : p.model,
      reasoning: back ? cfg.reasoning : "auto",
      contextLength: back ? cfg.contextLength : 0,
    });
  };

  const models = list.data?.models ?? [];
  const listed = models.find((m) => m.id === draft.model);
  const info: ModelInfo | null = listed ?? (test?.info?.id === draft.model ? test.info : null);
  const spec = info ? info.reasoning : null;
  // when nothing says what the model takes, a level chosen for it before stays on offer
  const choices = spec === null ? REASONING_CHOICES.filter((c) => c === draft.reasoning || reasoningChoices(null).includes(c)) : reasoningChoices(spec);
  const choice: ReasoningChoice = choices.includes(draft.reasoning) ? draft.reasoning : "auto";
  const auto = contextFor({ contextLength: 0, provider: draft.provider }, info);
  const ctx = contextFor({ contextLength: draft.contextLength, provider: draft.provider }, info);
  const dirty = !same(draft, saved);
  const extraOk = isJsonObject(draft.extraBody);
  const keyStale = isMaskedKey(draft.apiKey) && keyTarget(draft) !== keyTarget(saved);

  const pick = (m: ModelInfo) => {
    // a new model starts from its own context window and from "auto" where the old choice does not apply
    edit({ model: m.id, contextLength: 0, reasoning: reasoningChoices(m.reasoning).includes(draft.reasoning) ? draft.reasoning : "auto" });
    picker.close();
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.translateTest({ ...draft, reasoning: choice }));
    } catch (e) {
      toastError(e);
    } finally {
      setTesting(false);
    }
  };
  const apply = async () => {
    setSaving(true);
    try {
      await save({ translate: { ...cfg, ...draft, reasoning: choice } });
      // the form takes what the server kept (the key comes back masked); an unchanged cache means the save failed,
      // and save() has said so already
      const next = qc.getQueryData<Bootstrap>(keys.bootstrap)?.settings.translate;
      if (next && next !== cfg) {
        setDraft(draftOf(next));
        toast("已保存：翻译和要点都会用这个模型");
      }
    } finally {
      setSaving(false);
    }
  };

  const modelNote = (() => {
    if (info) return [info.name, ...facts(info)].filter(Boolean).join(" · ");
    if (!reachable) return "填写 API Key 之后，可以从列表里选模型";
    if (list.isFetching && !list.data) return "正在获取模型列表…";
    if (list.data?.error && !models.length) return `${list.data.error}。可以直接填写模型名`;
    if (draft.model && models.length) return "列表里没有这个模型，请确认名字是否写对";
    return draft.model ? "" : "填写或选择一个模型";
  })();

  return (
    <section className="settings-section" id="translate">
      <h2>翻译与要点</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>AI 服务</b>
            <span>翻译和「要点」都用这个模型。{preset.hint}</span>
          </div>
          <div className="ai-form">
            <label htmlFor="ai-preset">服务</label>
            <select id="ai-preset" className="field" value={preset.id} onChange={(e) => choosePreset(e.target.value)}>
              {PRESET_GROUPS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {PRESETS.filter((p) => p.group === g.id).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {preset.editableUrl && (
              <>
                <label htmlFor="ai-url">地址</label>
                <input id="ai-url" className="field mono" placeholder={preset.baseUrl || "https://…/v1"} value={draft.baseUrl} onChange={(e) => edit({ baseUrl: e.target.value })} spellCheck={false} />
              </>
            )}

            {(preset.needsKey || preset.id === "custom") && (
              <>
                <label htmlFor="ai-key">API Key</label>
                <div className="ai-cell">
                  <div className="ai-row">
                    <input id="ai-key" className="field mono" type="password" autoComplete="off" placeholder={preset.needsKey ? "粘贴 API Key" : "不需要的话留空"} value={draft.apiKey} onChange={(e) => edit({ apiKey: e.target.value.trim() })} />
                    {preset.keyUrl && (
                      <a className="btn sm ghost" href={preset.keyUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={13} />
                        申请
                      </a>
                    )}
                  </div>
                  {keyStale && <p className="ai-help bad">地址改了：保存的 Key 只会发往原来的地址，请重新粘贴一次。</p>}
                </div>
              </>
            )}

            <label htmlFor="ai-model">模型</label>
            <div className="ai-cell">
              <div className="ai-row">
                <input id="ai-model" className="field mono" placeholder="模型名" value={draft.model} onChange={(e) => edit({ model: e.target.value.trim() })} spellCheck={false} autoComplete="off" />
                <button ref={picker.ref} type="button" className="btn sm" onClick={picker.toggle} aria-expanded={picker.open} aria-haspopup="listbox" disabled={!reachable}>
                  {list.isFetching ? <span className="spinner" /> : <ChevronDown size={14} />}
                  选择
                </button>
              </div>
              {modelNote && <p className="ai-help">{modelNote}</p>}
            </div>

            {spec !== false && (
              <>
                <span className="ai-label">推理强度</span>
                <div className="ai-cell">
                  <Segmented value={choice} onChange={(v) => edit({ reasoning: v })} options={choices.map((c) => ({ value: c, label: CHOICE_LABELS[c] }))} />
                  <p className="ai-help">{describePlan(choice, spec, draft.provider)}</p>
                </div>
              </>
            )}

            <label htmlFor="ai-ctx">上下文</label>
            <div className="ai-cell">
              <ContextField value={draft.contextLength} auto={auto} onChange={(contextLength) => edit({ contextLength })} />
              <p className="ai-help">
                {contextNote(ctx, preset, draft.provider)}决定一次翻译多少段，以及「要点」能读多长的文章。
              </p>
            </div>
          </div>

          <details className="ai-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
            <summary>高级：附加请求参数</summary>
            <textarea className="field mono" rows={3} placeholder='{"top_p": 0.9}' value={draft.extraBody} onChange={(e) => edit({ extraBody: e.target.value })} spellCheck={false} />
            <p className={`ai-help ${extraOk ? "" : "bad"}`}>{extraOk ? "一个 JSON 对象，原样并入每个请求，用来传服务独有的参数；和松果自己的字段同名时以这里为准。" : "这不是一个有效的 JSON 对象。"}</p>
          </details>

          <div className="bridge-status ai-status">
            {testing ? (
              <span className="muted">正在用一句话试试…</span>
            ) : test ? (
              test.ok ? (
                <span className="ai-result" title={test.text}>
                  <Check size={15} />
                  <span>
                    {(test.ms / 1000).toFixed(1)} 秒 · {test.reasoned ? `推理了${test.reasoningTokens ? ` ${test.reasoningTokens} token` : ""}` : "没有推理"} · {test.text}
                  </span>
                </span>
              ) : (
                <span className="bad">{test.error}</span>
              )
            ) : (
              <span className="muted">{dirty ? "改动还没保存，可以先测试一下" : "可以用一句话测试这个模型"}</span>
            )}
            <div className="ai-actions">
              {dirty && (
                <button type="button" className="btn sm ghost" onClick={() => (setDraft(saved), setTest(null))}>
                  还原
                </button>
              )}
              <button type="button" className="btn sm" disabled={testing || !draft.model || !extraOk} onClick={runTest}>
                {testing ? "测试中…" : "测试"}
              </button>
              <button type="button" className="btn sm primary" disabled={!dirty || saving || !extraOk} onClick={apply}>
                保存
              </button>
            </div>
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
      {picker.open && <ModelPicker anchor={picker.el} onClose={picker.close} list={list.data} loading={list.isFetching} value={draft.model} onPick={pick} onRefresh={refresh} />}
    </section>
  );
}
