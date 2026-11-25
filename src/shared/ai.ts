/**
 * The AI services behind translation and key points: which services Acorn knows how to talk to, and the rules the
 * server and the settings page share about a model's reasoning and context window. Dependency-free: the web app
 * imports it too.
 *
 * Modelled on Hermes Agent's provider setup: the model list and each model's capabilities come from the service
 * (or the models.dev catalog), and one "how hard to think" choice is turned into each service's own parameters
 * (src/server/translate/wire.ts).
 */
import type { ModelInfo, ReasoningChoice, ReasoningSpec, TranslateProvider } from "./types.ts";

export interface Preset {
  id: string;
  label: string;
  group: "local" | "cn" | "global" | "custom";
  protocol: TranslateProvider;
  /** The API root; for local servers and custom endpoints, what the address field starts from. */
  baseUrl: string;
  /** A good default for translation and key points: fast, cheap, able to switch reasoning off. */
  model: string;
  needsKey: boolean;
  keyUrl?: string;
  hint: string;
  /** The service's id in the models.dev catalog, which fills in what its own model list leaves out. */
  catalog?: string;
  /** The address can be changed (local servers, self-hosted and custom endpoints). */
  editableUrl?: boolean;
}

export const PRESETS: Preset[] = [
  { id: "ollama", label: "本机 Ollama", group: "local", protocol: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", needsKey: false, editableUrl: true, hint: "免费、离线，文章不出这台电脑。先装 Ollama，再下载一个模型，例如 ollama pull qwen3:8b" },
  { id: "lmstudio", label: "LM Studio", group: "local", protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "", needsKey: false, editableUrl: true, catalog: "lmstudio", hint: "在 LM Studio 的「Developer」里启动本地服务器，再加载一个模型" },
  { id: "deepseek", label: "DeepSeek", group: "cn", protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys", catalog: "deepseek", hint: "便宜，中文好" },
  { id: "qwen", label: "通义千问（阿里云百炼）", group: "cn", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", needsKey: true, keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key", catalog: "alibaba-cn", hint: "阿里云百炼的 OpenAI 兼容接口" },
  { id: "moonshot", label: "Kimi（月之暗面）", group: "cn", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", needsKey: true, keyUrl: "https://platform.moonshot.cn/console/api-keys", catalog: "moonshotai-cn", hint: "长上下文" },
  { id: "zhipu", label: "智谱 GLM", group: "cn", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash", needsKey: true, keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys", catalog: "zhipuai", hint: "有免费的 Flash 模型" },
  { id: "volcengine", label: "火山方舟（豆包）", group: "cn", protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-flash-250828", needsKey: true, keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", catalog: "volcengine", hint: "字节跳动的模型平台；模型要先在控制台开通" },
  { id: "siliconflow", label: "硅基流动", group: "cn", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-8B", needsKey: true, keyUrl: "https://cloud.siliconflow.cn/account/ak", catalog: "siliconflow-cn", hint: "汇集各家开源模型，有免费的小模型" },
  { id: "openrouter", label: "OpenRouter", group: "global", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash", needsKey: true, keyUrl: "https://openrouter.ai/settings/keys", catalog: "openrouter", hint: "一个 Key 用几百个模型" },
  { id: "openai", label: "OpenAI", group: "global", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", needsKey: true, keyUrl: "https://platform.openai.com/api-keys", catalog: "openai", hint: "GPT 系列" },
  { id: "anthropic", label: "Claude", group: "global", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys", catalog: "anthropic", hint: "Anthropic 的 Messages API" },
  { id: "gemini", label: "Google Gemini", group: "global", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", needsKey: true, keyUrl: "https://aistudio.google.com/apikey", catalog: "google", hint: "Gemini 的 OpenAI 兼容接口；在中国大陆需要代理才能连上" },
  { id: "custom", label: "其他 OpenAI 兼容接口", group: "custom", protocol: "openai", baseUrl: "", model: "", needsKey: false, editableUrl: true, hint: "vLLM、llama.cpp、One API、各种中转服务……填它们的 /v1 地址；不需要 Key 的可以留空" },
];

export const PRESET_GROUPS: { id: Preset["group"]; label: string }[] = [
  { id: "local", label: "本机" },
  { id: "cn", label: "国内" },
  { id: "global", label: "国外" },
  { id: "custom", label: "其他" },
];

export const presetById = (id: string | undefined): Preset | undefined => PRESETS.find((p) => p.id === id);

const root = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

/** The preset a configuration belongs to, for settings saved before presets existed. */
export function presetFor(provider: TranslateProvider, baseUrl: string): Preset {
  if (provider === "ollama") return presetById("ollama")!;
  if (provider === "anthropic") return presetById("anthropic")!;
  const url = root(baseUrl);
  if (url) {
    const same = PRESETS.find((p) => p.protocol === provider && p.baseUrl && root(p.baseUrl) === url);
    if (same) return same;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })();
    // the same service on another path or region (api.deepseek.com/v1, dashscope-intl…)
    const near = PRESETS.find((p) => p.protocol === provider && p.baseUrl && !p.editableUrl && host && new URL(p.baseUrl).host.split(".").slice(-2).join(".") === host.split(".").slice(-2).join("."));
    if (near) return near;
    return presetById("custom")!;
  }
  return presetById("openai")!;
}

/** The address requests go to: what was typed, or the preset's. */
export function serviceUrl(preset: Preset | undefined, baseUrl: string): string {
  return (baseUrl || preset?.baseUrl || "").trim().replace(/\/+$/, "");
}

/** Saved API keys reach clients masked: "••••" and the last four characters, so keys can be told apart. */
export const KEY_MASK = "••••";
export const isMaskedKey = (key: string): boolean => key.startsWith(KEY_MASK);

/**
 * Where a key is sent. A saved key goes only to the service and address it was entered for: a masked key under a
 * new address stands for no key at all, so changing the address never hands the old key to someone else.
 */
export const keyTarget = (t: { provider: TranslateProvider; preset: string; baseUrl: string }): string => `${t.provider}|${serviceUrl(presetById(t.preset), t.baseUrl).toLowerCase()}`;

// ───────────────────────── reasoning ─────────────────────────

/** Reasoning levels, cheapest first. "none" switches reasoning off where a model allows it. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (v: unknown): v is Effort => (EFFORTS as readonly unknown[]).includes(v);

export const CHOICE_LABELS: Record<ReasoningChoice, string> = {
  auto: "自动",
  off: "关闭",
  on: "开启",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export const REASONING_CHOICES = Object.keys(CHOICE_LABELS) as ReasoningChoice[];

export const canDisable = (spec: ReasoningSpec): boolean => spec.toggle || spec.efforts.includes("none");

/** The choices worth offering for a model: what it accepts, and nothing it would reject. */
export function reasoningChoices(spec: ReasoningSpec | false | null): ReasoningChoice[] {
  if (spec === false) return [];
  if (spec === null) return ["auto", "off", "low", "medium", "high"];
  const out: ReasoningChoice[] = ["auto"];
  if (canDisable(spec)) out.push("off");
  const levels = spec.efforts.filter((l): l is Exclude<Effort, "none"> => l !== "none");
  if (levels.length) out.push(...levels);
  else if (spec.budget) out.push("low", "medium", "high");
  else if (spec.toggle) out.push("on");
  return out;
}

/** What a choice comes down to for one model. */
export type ReasoningPlan =
  | { send: "nothing" }
  | { send: "off" }
  | { send: "on" }
  | { send: "effort"; level: Effort }
  | { send: "budget"; tokens: number };

const BUDGETS: Record<string, number> = { minimal: 512, low: 1024, medium: 4096, on: 4096, high: 16_384, xhigh: 32_768, max: 65_536 };

function nearest(level: Effort, levels: Effort[]): Effort {
  const at = EFFORTS.indexOf(level);
  // the closest one; between two equally close, the cheaper
  return [...levels].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - at) - Math.abs(EFFORTS.indexOf(b) - at) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

function budgetFor(choice: string, range: { min?: number; max?: number }): number {
  return Math.min(Math.max(BUDGETS[choice] ?? BUDGETS.low, range.min ?? 0), range.max ?? Infinity);
}

/** As little reasoning as the model allows. */
function cheapest(spec: ReasoningSpec): ReasoningPlan {
  const levels = spec.efforts.filter((l) => l !== "none");
  if (levels.length) return { send: "effort", level: levels[0] };
  if (spec.budget) return { send: "budget", tokens: budgetFor("minimal", spec.budget) };
  return { send: "nothing" };
}

/**
 * Turn the setting into what to send for this model. Unknown models get nothing unless the user chose something:
 * a parameter the service does not know can be an error, and its own default is a safe start. The exception is a
 * local Ollama, which is always asked not to think: a model that thinks first is several times slower there, and
 * Ollama ignores `think: false` for models that cannot think.
 */
export function planReasoning(choice: ReasoningChoice, spec: ReasoningSpec | false | null, provider?: TranslateProvider): ReasoningPlan {
  if (spec === false) return { send: "nothing" };
  if (spec === null) {
    if (choice === "auto") return provider === "ollama" ? { send: "off" } : { send: "nothing" };
    if (choice === "off" || choice === "on") return { send: choice };
    return { send: "effort", level: choice };
  }
  if (choice === "auto" || choice === "off") return canDisable(spec) ? { send: "off" } : cheapest(spec);
  const levels = spec.efforts.filter((l) => l !== "none");
  if (choice === "on") {
    if (spec.toggle) return { send: "on" };
    if (levels.length) return { send: "effort", level: nearest("medium", levels) };
    return spec.budget ? { send: "budget", tokens: budgetFor("on", spec.budget) } : { send: "nothing" };
  }
  if (levels.length) return { send: "effort", level: nearest(choice, levels) };
  if (spec.budget) return { send: "budget", tokens: budgetFor(choice, spec.budget) };
  if (spec.toggle) return { send: "on" };
  return { send: "nothing" };
}

const levelName = (level: string): string => CHOICE_LABELS[level as ReasoningChoice] ?? level;

/** One line for the settings page: what the choice will do with this model. */
export function describePlan(choice: ReasoningChoice, spec: ReasoningSpec | false | null, provider?: TranslateProvider): string {
  if (spec === false) return "这个模型不做推理，直接回答。";
  const plan = planReasoning(choice, spec, provider);
  if (spec === null) {
    if (choice === "auto" && plan.send === "off") return "翻译和提炼要点用不着深度思考：会请 Ollama 关掉推理，本机模型先推理会慢好几倍；不会推理的模型不受影响。";
    if (plan.send === "nothing") return "没查到这个模型怎么控制推理，所以不发送推理参数，由服务按它的默认来；模型支持的话，也可以手动选一档。";
    return "没查到这个模型是否支持这一档；不支持的服务可能报错，「测试」一下就知道。";
  }
  const lowest = plan.send === "effort" ? `这个模型不能关闭推理，会用最低的一档「${levelName(plan.level)}」。` : plan.send === "budget" ? `这个模型不能关闭推理，会把推理限制在 ${formatTokens(plan.tokens)} token 以内。` : "";
  if (choice === "auto") return plan.send === "off" ? "翻译和提炼要点用不着深度思考：会关掉推理，回答更快、更省钱。" : lowest || "由服务按它的默认来。";
  if (choice === "off") return plan.send === "off" ? "不推理，直接回答：最快。" : lowest || "这个模型不能关闭推理。";
  if (plan.send === "budget") return `推理最多用 ${formatTokens(plan.tokens)} token。推理越深，要点越周到，但翻译会明显变慢、更贵。`;
  return "推理越深，要点越周到，但翻译会明显变慢、更贵。";
}

// ───────────────────────── context window ─────────────────────────

/** When nothing says how large a model's context is (the same fallback Hermes uses). */
export const DEFAULT_CONTEXT = 128_000;
/** What Acorn asks a local Ollama for unless told otherwise: its memory use grows with the window, and 8K fits a laptop. */
export const OLLAMA_CONTEXT = 8192;

export interface ContextWindow {
  tokens: number;
  /** pinned: set by the user; service / catalog: reported for the model; default: assumed. */
  source: "pinned" | "service" | "catalog" | "default";
  /** The most the model supports, when that is known. */
  max?: number;
}

/** The context window requests are planned for. */
export function contextFor(cfg: { contextLength: number; provider: TranslateProvider }, info: ModelInfo | null | undefined): ContextWindow {
  const max = info?.context;
  if (cfg.contextLength > 0) return { tokens: cfg.contextLength, source: "pinned", max };
  if (cfg.provider === "ollama") return { tokens: Math.min(OLLAMA_CONTEXT, max ?? OLLAMA_CONTEXT), source: "default", max };
  if (max) return { tokens: max, source: info?.source ?? "service", max };
  return { tokens: DEFAULT_CONTEXT, source: "default" };
}

/** 8192 → "8K", 131072 → "128K", 128000 → "128K", 1048576 → "1M", 1050000 → "1.05M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  // decimal first: 128000 is also 125 × 1024, and nobody calls it 125K (no power of two is a multiple of 1000)
  for (const unit of [1_000_000, 1024 * 1024]) if (n >= unit && n % unit === 0) return `${n / unit}M`;
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  for (const unit of [1000, 1024]) if (n >= unit && n % unit === 0) return `${n / unit}K`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** What people type for a context window: "32768", "32k", "128K", "1m", "1.5M". 0 when it is not one. */
export function parseTokens(text: string): number {
  const m = text.trim().toLowerCase().replace(/[,，_\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?(?:tokens?)?$/);
  if (!m) return 0;
  const n = Number(m[1]) * (m[2] === "m" ? 1024 * 1024 : m[2] === "k" ? 1024 : 1);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 0;
}

const dollars = (v: number): string => "$" + (v > 0 && v < 0.1 ? String(Number(v.toPrecision(2))) : v.toFixed(2));

/** "$0.15 / $0.60" per million tokens, in and out; "免费" when both are zero. */
export function formatPrice(price: ModelInfo["price"]): string {
  if (!price) return "";
  if (!price.input && !price.output) return "免费";
  return `${dollars(price.input)} / ${dollars(price.output)}`;
}
