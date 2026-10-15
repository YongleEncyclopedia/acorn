/**
 * Translation engines. One prompt format for every provider: numbered segments in, numbered segments out.
 * - ollama: local models through Ollama's native API (lets us switch off Qwen3-style "thinking")
 * - openai: any OpenAI-compatible chat API (OpenAI, DeepSeek, Qwen/DashScope, OpenRouter, LM Studio…)
 * - anthropic: Claude's Messages API
 */
import type { TranslateSettings } from "../../shared/types.ts";
import { langName } from "../../shared/translate.ts";

export const DEFAULT_BASE: Record<TranslateSettings["provider"], string> = {
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export class TranslateError extends Error {}

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
    const msg = data.error?.message || data.error || text.slice(0, 200) || res.statusText;
    throw new TranslateError(`翻译服务返回 HTTP ${res.status}：${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/** Send one chat request and return the reply text. */
export async function complete(cfg: TranslateSettings, systemPrompt: string, user: string, timeoutMs = 180_000): Promise<string> {
  const base = (cfg.baseUrl || DEFAULT_BASE[cfg.provider]).replace(/\/+$/, "");
  if (!cfg.model) throw new TranslateError("还没有设置翻译模型（设置 → 翻译）");
  if (cfg.provider === "ollama") {
    const d = await post(
      `${base}/api/chat`,
      {},
      { model: cfg.model, stream: false, think: false, keep_alive: "5m", options: { temperature: 0.2, num_ctx: 8192 }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: user }] },
      timeoutMs,
    ).catch((err: Error) => {
      if (/model .*not found|HTTP 404/i.test(err.message)) throw new TranslateError(`本机 Ollama 里没有 ${cfg.model}：先运行 ollama pull ${cfg.model}，或在设置里换一个模型`);
      if (/think/i.test(err.message)) throw new TranslateError(`${cfg.model} 不支持关闭思考模式，请升级 Ollama 或换一个模型`);
      throw err;
    });
    return String(d.message?.content || "");
  }
  if (!cfg.apiKey) throw new TranslateError("还没有填写 API Key（设置 → 翻译）");
  if (cfg.provider === "anthropic") {
    const d = await post(
      `${base}/messages`,
      { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      { model: cfg.model, max_tokens: 8192, temperature: 0.2, system: systemPrompt, messages: [{ role: "user", content: user }] },
      timeoutMs,
    );
    return (d.content || []).map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : "")).join("");
  }
  const d = await post(
    `${base}/chat/completions`,
    { authorization: `Bearer ${cfg.apiKey}` },
    { model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: user }] },
    timeoutMs,
  );
  return String(d.choices?.[0]?.message?.content || "");
}

/** Translate a batch of plain-text segments. Falls back to one request per segment if the numbering gets lost. */
export async function translateBatch(cfg: TranslateSettings, texts: string[], lang: string): Promise<string[]> {
  const reply = await complete(cfg, system(lang), buildPrompt(texts));
  const parsed = parseReply(reply, texts.length);
  if (parsed) return parsed;
  if (texts.length === 1) throw new TranslateError("翻译模型没有按格式返回译文");
  const out: string[] = [];
  for (const t of texts) out.push(...(await translateBatch(cfg, [t], lang)));
  return out;
}
