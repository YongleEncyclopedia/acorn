/**
 * What a service offers: its models, each with its context window, reasoning controls and price, asked from the
 * service itself and filled in from the models.dev catalog. The settings page lists them before anything is saved
 * (so a new key can be tried); the engine looks up the one it talks to, to know how to steer it.
 */
import type { App } from "../app.ts";
import type { ModelInfo, ModelList, ReasoningSpec, TranslateProvider } from "../../shared/types.ts";
import { EFFORTS, isEffort, presetById, serviceUrl, type Effort, type Preset } from "../../shared/ai.ts";
import { catalogEntry, catalogModels, enrich, infoFromEntry, loadCatalog, providerForUrl, releasedAt, type Catalog } from "./catalog.ts";

/** Enough to reach a service: what the settings page has typed so far, or what is saved. */
export interface Connection {
  provider: TranslateProvider;
  preset: string;
  baseUrl: string;
  apiKey: string;
}

const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref());
const byEffort = (a: Effort, b: Effort) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Chat models only: a service's list also holds embedding, speech, image and moderation models. */
const NOT_CHAT = /(^|[-_/.:])(embed|embedding|embeddings|rerank|reranker|tts|whisper|transcribe|dall-e|gpt-image|imagen|moderation|audio|speech|realtime|ocr|sora|veo)([-_/.:]|$)/i;

class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ServiceError(res.status, `HTTP ${res.status}`);
  return res.json();
}

const authHeaders = (c: Connection): Record<string, string> =>
  c.provider === "anthropic" ? { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" } : c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {};

/** Why a service could not be asked, in words the settings page can show. */
function describe(err: unknown, url: string, hasKey: boolean): string {
  const e = err as Error & { status?: number; cause?: { code?: string } };
  const h = hostOf(url);
  if (e.status === 401 || e.status === 403) return hasKey ? "API Key 不对，或者这个 Key 没有权限" : "要先填写 API Key，才能列出这个服务的模型";
  if (e.status === 404) return `${h} 没有提供模型列表`;
  if (e.status) return `${h} 返回 HTTP ${e.status}`;
  if (e.cause?.code === "ECONNREFUSED") return `连不上 ${h}：服务没有运行`;
  if (e.cause?.code === "ENOTFOUND" || e.cause?.code === "EAI_AGAIN") return `找不到 ${h}：地址写错了，或者没有联网`;
  if (e.name === "TimeoutError") return `${h} 没有响应`;
  return e.message;
}

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** The catalog if it is quick to get; the settings page does not wait for a slow models.dev (it loads on in the background). */
const catalogSoon = (app: App): Promise<Catalog | null> => Promise.race([loadCatalog(app).catch(() => null), sleep(4000).then(() => null)]);

// ───────────────────────── Ollama ─────────────────────────

interface OllamaTag {
  name: string;
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

interface OllamaShow {
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  /** Ollama 0.13+: the values `think` accepts, e.g. [true, false] or ["low", "medium", "high"]. */
  thinking?: { values?: unknown[]; default?: unknown };
  details?: { parameter_size?: string; quantization_level?: string };
}

const ollamaShow = (base: string, model: string): Promise<OllamaShow> =>
  getJson(`${base}/api/show`, { "content-type": "application/json" }, 5000, { method: "POST", body: JSON.stringify({ model }) });

/** How `think` steers a local model: from its `thinking` values, or from older Ollamas' capability list. */
export function ollamaSpec(show: OllamaShow | null): ReasoningSpec | false | null {
  if (!show) return null;
  const values = show.thinking?.values;
  if (Array.isArray(values)) {
    if (!values.some((v) => v === true || typeof v === "string")) return false;
    return { toggle: values.includes(false), efforts: values.filter(isEffort).sort(byEffort), budget: null };
  }
  if (Array.isArray(show.capabilities)) return show.capabilities.includes("thinking") ? { toggle: true, efforts: [], budget: null } : false;
  return null;
}

/** null for models that do not chat (embeddings). */
function ollamaInfo(tag: OllamaTag, show: OllamaShow | null): ModelInfo | null {
  if (show?.capabilities && !show.capabilities.includes("completion")) return null;
  const info = show?.model_info || {};
  const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
  const d = show?.details || tag.details || {};
  const size = tag.size ? `${(tag.size / 1e9).toFixed(1)} GB` : "";
  return {
    id: tag.name,
    context: ctxKey ? num(info[ctxKey]) : undefined,
    reasoning: ollamaSpec(show),
    detail: [d.parameter_size, d.quantization_level, size].filter(Boolean).join(" · ") || undefined,
    source: show ? "service" : undefined,
  };
}

async function listOllama(base: string): Promise<ModelInfo[]> {
  const d = await getJson(`${base}/api/tags`, {}, 5000);
  const tags = ((d.models || []) as OllamaTag[]).slice(0, 80);
  const infos = await mapLimit(tags, 6, async (t) => ollamaInfo(t, await ollamaShow(base, t.name).catch(() => null)));
  return infos.filter((m): m is ModelInfo => !!m);
}

// ───────────────────────── Claude ─────────────────────────

interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Record<string, any>;
}

/** Claude models whose thinking cannot be switched off: effort is their only control. */
const ALWAYS_THINKS = /^claude-(fable|mythos|opus-5-5)/;

/** The Models API reports, for each model, its effort levels and which kinds of thinking it takes. */
export function anthropicSpec(m: AnthropicModel): ReasoningSpec | false | null {
  const caps = m.capabilities;
  if (!caps) return null;
  const thinking = caps.thinking;
  if (thinking?.supported === false) return false;
  const effort = caps.effort;
  const levels = effort?.supported ? (["low", "medium", "high", "xhigh", "max"] as const).filter((l) => effort[l]?.supported) : [];
  // models before adaptive thinking take a fixed budget instead (Claude Haiku 4.5 and older)
  const budgetOnly = !!thinking?.types?.enabled?.supported && !thinking?.types?.adaptive?.supported;
  return { toggle: !ALWAYS_THINKS.test(m.id), efforts: [...levels], budget: budgetOnly ? { min: 1024 } : null };
}

const anthropicInfo = (m: AnthropicModel): ModelInfo => ({
  id: m.id,
  name: m.display_name,
  context: num(m.max_input_tokens),
  maxOutput: num(m.max_tokens),
  reasoning: anthropicSpec(m),
  source: "service",
});

async function listAnthropic(base: string, c: Connection): Promise<ModelInfo[]> {
  const out: AnthropicModel[] = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const d = await getJson(`${base}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, authHeaders(c), 8000);
    out.push(...((d.data || []) as AnthropicModel[]));
    if (!d.has_more || !d.last_id) break;
    after = d.last_id;
  }
  return out.map(anthropicInfo);
}

// ───────────────────────── OpenAI-compatible ─────────────────────────

/** A /models entry. Most services give only `id`; OpenRouter, vLLM and others add their own fields. */
interface CompatModel {
  id: string;
  name?: string;
  context_length?: number;
  max_model_len?: number;
  context_window?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: { prompt?: string; completion?: string };
  reasoning?: { supported_efforts?: string[] | null; mandatory?: boolean; supports_max_tokens?: boolean };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
}

/** OpenRouter describes each model's reasoning controls; models without a `reasoning` object do not reason. */
export function openRouterSpec(m: CompatModel): ReasoningSpec | false | null {
  if (!Array.isArray(m.supported_parameters)) return null;
  const r = m.reasoning;
  if (!r) return m.supported_parameters.includes("reasoning") ? null : false;
  // null: every level the gateway knows; missing: the model takes no level, only on and off
  const levels = r.supported_efforts === null ? [...EFFORTS] : (r.supported_efforts || []).filter(isEffort);
  return {
    toggle: !r.mandatory && r.supported_efforts === undefined,
    efforts: levels.filter((l) => !(r.mandatory && l === "none")).sort(byEffort),
    budget: r.supports_max_tokens ? {} : null,
  };
}

function compatInfo(m: CompatModel): ModelInfo {
  // OpenRouter prices are dollars per token, as strings ("-1" for routers whose price varies)
  const input = Number(m.pricing?.prompt);
  const output = Number(m.pricing?.completion);
  const priced = m.pricing && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0;
  const context = num(m.context_length) ?? num(m.top_provider?.context_length) ?? num(m.max_model_len) ?? num(m.context_window);
  return {
    id: m.id,
    name: m.name && m.name !== m.id ? m.name : undefined,
    context,
    maxOutput: num(m.top_provider?.max_completion_tokens),
    reasoning: openRouterSpec(m),
    temperature: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("temperature") : undefined,
    price: priced ? { input: input * 1e6, output: output * 1e6 } : undefined,
    source: context || Array.isArray(m.supported_parameters) ? "service" : undefined,
  };
}

async function listCompat(base: string, c: Connection): Promise<ModelInfo[]> {
  const d = await getJson(`${base}/models`, authHeaders(c), 10_000);
  const data = (Array.isArray(d) ? d : d.data || d.models || []) as CompatModel[];
  return data
    .filter((m) => m && typeof m.id === "string" && (!m.architecture?.output_modalities || m.architecture.output_modalities.includes("text")))
    .map(compatInfo);
}

interface LmStudioModel {
  id: string;
  type?: string;
  arch?: string;
  quantization?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

/** LM Studio's own API says which models are loaded and with how much context; its /v1/models does not. */
async function listLmStudio(base: string): Promise<ModelInfo[] | null> {
  try {
    const d = await getJson(`${base.replace(/\/v1$/, "")}/api/v0/models`, {}, 4000);
    return ((d.data || []) as LmStudioModel[])
      .filter((m) => m.type !== "embeddings")
      .map((m) => ({
        id: m.id,
        context: num(m.loaded_context_length) ?? num(m.max_context_length),
        reasoning: null,
        detail: [m.arch, m.quantization, m.state === "loaded" ? "已加载" : ""].filter(Boolean).join(" · ") || undefined,
        source: "service",
      }));
  } catch {
    return null;
  }
}

// ───────────────────────── listing and looking up ─────────────────────────

const catalogProviders = (preset: Preset | undefined, cat: Catalog | null, base: string) => [preset?.catalog, cat ? providerForUrl(cat, base) : null];

/** Every chat model the service offers, with what is known about each. Never throws: failures come back as `error`. */
export async function listModels(app: App, c: Connection): Promise<ModelList> {
  const preset = presetById(c.preset);
  const base = serviceUrl(preset, c.baseUrl);
  if (!base) return { models: [], source: "none", error: "还没有填写服务地址" };
  const cat = await catalogSoon(app);
  const providers = catalogProviders(preset, cat, base);
  try {
    let models =
      c.provider === "ollama"
        ? await listOllama(base)
        : c.provider === "anthropic"
          ? await listAnthropic(base, c)
          : (c.preset === "lmstudio" && (await listLmStudio(base))) || (await listCompat(base, c));
    models = models.filter((m) => !NOT_CHAT.test(m.id));
    // local tags ("qwen3:8b") are not catalog ids, and a local model's limits are the ones it runs with
    if (cat && c.provider !== "ollama" && c.preset !== "lmstudio") models = models.map((m) => enrich(m, catalogEntry(cat, providers, m.id)));
    // OpenRouter and Anthropic list newest first already; others mostly alphabetically
    if (cat && c.preset !== "openrouter" && c.provider !== "anthropic" && c.provider !== "ollama") {
      const when = new Map(models.map((m) => [m.id, releasedAt(cat, providers, m.id)]));
      models.sort((a, b) => when.get(b.id)!.localeCompare(when.get(a.id)!) || a.id.localeCompare(b.id));
    }
    return { models, source: "service" };
  } catch (err) {
    const error = describe(err, base, !!c.apiKey);
    // Some services have no list endpoint (or need a key for it): offer what the catalog knows they serve.
    const known = cat && preset?.catalog ? catalogModels(cat, preset.catalog).filter((m) => !NOT_CHAT.test(m.id)) : [];
    return { models: known, source: known.length ? "catalog" : "none", error };
  }
}

const lists = new Map<string, { at: number; models: ModelInfo[] }>();
const infos = new Map<string, { at: number; info: ModelInfo | null }>();

async function cachedList(app: App, c: Connection, base: string): Promise<ModelInfo[]> {
  const key = `${c.provider}|${base}|${c.apiKey.slice(-6)}`;
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
  const list = await listModels(app, c);
  if (list.source === "service") lists.set(key, { at: Date.now(), models: list.models });
  return list.models;
}

async function resolveInfo(app: App, c: Connection & { model: string }, preset: Preset | undefined, base: string): Promise<ModelInfo | null> {
  if (c.provider === "ollama") {
    const show = await ollamaShow(base, c.model).catch(() => null);
    return show ? ollamaInfo({ name: c.model }, show) : null;
  }
  const cat = await loadCatalog(app);
  const entry = cat ? catalogEntry(cat, catalogProviders(preset, cat, base), c.model) : null;
  if (c.provider === "anthropic") {
    const m = await getJson(`${base}/models/${encodeURIComponent(c.model)}`, authHeaders(c), 6000).catch(() => null);
    return m?.id ? enrich(anthropicInfo(m), entry) : entry ? infoFromEntry(c.model, entry) : null;
  }
  // Most hosted models are in the catalog; aggregators and local servers describe their own models better.
  if (entry && c.preset !== "openrouter" && c.preset !== "lmstudio") return infoFromEntry(c.model, entry);
  const listed = (await cachedList(app, c, base)).find((m) => m.id === c.model);
  return listed ? enrich(listed, entry) : entry ? infoFromEntry(c.model, entry) : null;
}

/**
 * What is known about the model a configuration uses: how to steer its reasoning, how large its context is.
 * Cached for half an hour (five minutes when nothing was found); never waits more than a few seconds.
 */
export async function modelInfo(app: App, c: Connection & { model: string }): Promise<ModelInfo | null> {
  if (!c.model) return null;
  const preset = presetById(c.preset);
  const base = serviceUrl(preset, c.baseUrl);
  const key = `${c.provider}|${base}|${c.model}`;
  const hit = infos.get(key);
  if (hit && Date.now() - hit.at < (hit.info ? 30 * 60_000 : 5 * 60_000)) return hit.info;
  const info = await Promise.race([resolveInfo(app, c, preset, base).catch(() => null), sleep(6000)]);
  if (info === undefined) return null; // too slow this time: not remembered, asked again next time
  infos.set(key, { at: Date.now(), info });
  return info;
}

/** Forget what was looked up (tests; a configuration that was just changed). */
export function forgetModelInfo(): void {
  lists.clear();
  infos.clear();
}
