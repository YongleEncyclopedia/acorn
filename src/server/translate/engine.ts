/**
 * The engines behind translation and key points. One prompt format for every service: numbered segments in,
 * numbered segments out.
 * - ollama: local models through Ollama's native API (which takes `think` and `num_ctx`; its OpenAI-compatible one does not)
 * - openai: any OpenAI-compatible chat API (OpenAI, DeepSeek, Qwen, Kimi, GLM, OpenRouter, LM Studio, vLLM…)
 * - anthropic: Claude's Messages API
 * How hard the model reasons and how large its context is come from the settings and the model's ModelInfo (models.ts).
 */
import type { ModelInfo, TranslateSettings } from "../../shared/types.ts";
import { langName } from "../../shared/translate.ts";
import { contextFor, planReasoning, presetById, serviceUrl, type ReasoningPlan } from "../../shared/ai.ts";
import { reasoningBody, wireFor, type Body } from "./wire.ts";

export const DEFAULT_BASE: Record<TranslateSettings["provider"], string> = {
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export class TranslateError extends Error {
  /** The service's HTTP status, when it answered with an error. */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const system = (lang: string) =>
  `You are a professional translator. Translate every numbered segment into ${langName(lang)}.
Rules:
- Start each translation with the same marker as its source, like [[3]], one segment per marker, in the same order.
- Output only the translations: no notes, no explanations, no source text.
- Keep names of people, products and code, URLs, numbers and inline code unchanged when they should not be translated.
- Write natural, fluent ${langName(lang)} that a native reader would enjoy; keep the tone of the original.`;

export function buildPrompt(texts: string[]): string {
  return texts.map((t, i) => `[[${i + 1}]] ${t.replace(/\[\[(\d+)\]\]/g, "[ [$1] ]")}`).join("\n\n");
}

/** Split a model reply back into segments; null when the numbering does not line up. */
export function parseReply(reply: string, count: number): string[] | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const out: string[] = new Array(count).fill("");
  const re = /\[\[(\d+)\]\]([\s\S]*?)(?=\[\[\d+\]\]|$)/g;
  let seen = 0;
  for (const m of text.matchAll(re)) {
    const i = Number(m[1]) - 1;
    const t = m[2].trim();
    if (i < 0 || i >= count || !t || out[i]) continue;
    out[i] = t;
    seen++;
  }
  if (seen === count) return out;
  if (count === 1 && text && !/\[\[\d+\]\]/.test(text)) return [text];
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.cause?.code === "ECONNREFUSED") throw new TranslateError(`连不上 ${new URL(url).host}：翻译服务没有运行`);
    if (e.name === "TimeoutError") throw new TranslateError("翻译服务超时没有响应");
    throw new TranslateError(`翻译请求失败：${e.message}`);
  }
  const text = await res.text();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = data.error?.message || data.error || data.message || text.slice(0, 200) || res.statusText;
    throw new TranslateError(`翻译服务返回 HTTP ${res.status}：${typeof msg === "string" ? msg : JSON.stringify(msg)}`, res.status);
  }
  return data;
}

/** What came back, beyond the text. */
export interface Reply {
  text: string;
  /** The model reasoned before answering. */
  reasoned: boolean;
  reasoningTokens?: number;
  /** The reasoning fields that were sent, for the settings page's test. */
  sent: Body;
}

const NO_ROOM = "模型把输出额度都用在了推理上，没有给出结果：把「推理强度」调低，或者换一个模型";

/** Service and model pairs that answered a temperature with a 400: asked without one from then on. */
const noTemperature = new Set<string>();

function sendsTemperature(cfg: TranslateSettings, info: ModelInfo | null): boolean {
  if (info?.temperature === false) return false;
  // OpenAI's reasoning models only take the default, and most of its models now reason
  if (!info && cfg.preset === "openai") return false;
  return !noTemperature.has(`${cfg.preset}|${cfg.model}`);
}

/** The settings' extra request fields, as an object. */
function extraFields(cfg: TranslateSettings): Body {
  const text = (cfg.extraBody || "").trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Body;
  } catch {
    /* reported below */
  }
  throw new TranslateError("「附加请求参数」不是一个 JSON 对象（设置 → 翻译与要点 → 高级）");
}

/** Claude needs an output limit, and its reasoning is counted inside it. */
function claudeMaxTokens(plan: ReasoningPlan, info: ModelInfo | null): number {
  const room = plan.send === "budget" ? plan.tokens + 8192 : plan.send === "off" ? 8192 : 16_000;
  return Math.min(room, info?.maxOutput ?? Infinity);
}

/** A service that rejects the reasoning fields: the setting is the thing to change. */
function explain(err: unknown, sent: Body): never {
  const rejected = err instanceof TranslateError && err.status === 400 && Object.keys(sent).length > 0 && /reason|think|effort|budget/i.test(err.message);
  if (rejected) throw new TranslateError(`${err.message}（这个模型可能不接受这一档推理设置：把「推理强度」改成「自动」再试）`, 400);
  throw err;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);

/** Send one chat request. `info` (from modelInfo) says how to steer the model; without it, nothing is assumed. */
export async function chat(cfg: TranslateSettings, systemPrompt: string, user: string, opts: { info?: ModelInfo | null; timeoutMs?: number } = {}): Promise<Reply> {
  const preset = presetById(cfg.preset);
  const base = serviceUrl(preset, cfg.baseUrl) || DEFAULT_BASE[cfg.provider];
  if (!cfg.model) throw new TranslateError("还没有设置模型（设置 → 翻译与要点）");
  const info = opts.info ?? null;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const spec = info?.reasoning ?? null;
  const plan = planReasoning(cfg.reasoning, spec, cfg.provider);
  const sent = reasoningBody(plan, spec, wireFor(cfg));
  const extra = extraFields(cfg);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: user },
  ];

  if (cfg.provider === "ollama") {
    const body = { model: cfg.model, stream: false, keep_alive: "5m", ...sent, options: { temperature: 0.2, num_ctx: contextFor(cfg, info).tokens }, messages, ...extra };
    const d = await post(`${base}/api/chat`, {}, body, timeoutMs).catch((err: Error) => {
      if (/model .*not found|HTTP 404/i.test(err.message)) throw new TranslateError(`本机 Ollama 里没有 ${cfg.model}：先运行 ollama pull ${cfg.model}，或在设置里换一个模型`);
      if (/think/i.test(err.message)) throw new TranslateError(`${cfg.model} 不接受这一档推理设置，请升级 Ollama，或者把「推理强度」改成「自动」`);
      throw err;
    });
    return { text: String(d.message?.content || ""), reasoned: !!d.message?.thinking, sent };
  }

  if (!cfg.apiKey && preset?.needsKey !== false) throw new TranslateError("还没有填写 API Key（设置 → 翻译与要点）");

  if (cfg.provider === "anthropic") {
    // no temperature: current Claude models reject sampling parameters
    const body = { model: cfg.model, max_tokens: claudeMaxTokens(plan, info), system: systemPrompt, messages: [messages[1]], ...sent, ...extra };
    const d = await post(`${base}/messages`, { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }, body, timeoutMs).catch((err) => explain(err, sent));
    if (d.stop_reason === "refusal") throw new TranslateError("模型拒绝处理这段内容");
    const blocks = (d.content || []) as { type: string; text?: string }[];
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (!text.trim() && d.stop_reason === "max_tokens") throw new TranslateError(NO_ROOM);
    return { text, reasoned: blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking"), sent };
  }

  const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const ask = (temperature: boolean) => post(`${base}/chat/completions`, headers, { model: cfg.model, ...(temperature ? { temperature: 0.2 } : {}), messages, ...sent, ...extra }, timeoutMs);
  const withTemperature = sendsTemperature(cfg, info);
  let d: Record<string, any>;
  try {
    d = await ask(withTemperature);
  } catch (err) {
    // a model that takes no temperature says so with a 400: ask again without one, and remember that
    if (!withTemperature || !(err instanceof TranslateError) || err.status !== 400 || !/temperature/i.test(err.message)) explain(err, sent);
    noTemperature.add(`${cfg.preset}|${cfg.model}`);
    d = await ask(false).catch((e) => explain(e, sent));
  }
  const choice = d.choices?.[0];
  const msg = choice?.message || {};
  const text = String(msg.content || "");
  const reasoningTokens = num(d.usage?.completion_tokens_details?.reasoning_tokens);
  if (!text.trim() && choice?.finish_reason === "length") throw new TranslateError(NO_ROOM);
  return { text, reasoned: !!(msg.reasoning_content || msg.reasoning || reasoningTokens), reasoningTokens, sent };
}

/** Send one chat request and return the reply text. */
export async function complete(cfg: TranslateSettings, systemPrompt: string, user: string, opts: { info?: ModelInfo | null; timeoutMs?: number } = {}): Promise<string> {
  return (await chat(cfg, systemPrompt, user, opts)).text;
}

/** Translate a batch of plain-text segments. Falls back to one request per segment if the numbering gets lost. */
export async function translateBatch(cfg: TranslateSettings, texts: string[], lang: string, info: ModelInfo | null = null): Promise<string[]> {
  const reply = await complete(cfg, system(lang), buildPrompt(texts), { info });
  const parsed = parseReply(reply, texts.length);
  if (parsed) return parsed;
  if (texts.length === 1) throw new TranslateError("翻译模型没有按格式返回译文");
  const out: string[] = [];
  for (const t of texts) out.push(...(await translateBatch(cfg, [t], lang, info)));
  return out;
}

/** Translate one sentence and report how it went (the settings page's test). */
export async function trySentence(cfg: TranslateSettings, info: ModelInfo | null): Promise<Reply> {
  return chat(cfg, system(cfg.targetLang), buildPrompt(["The squirrel buries acorns in autumn and forgets half of them; the forgotten ones grow into the next forest."]), { info, timeoutMs: 120_000 });
}

