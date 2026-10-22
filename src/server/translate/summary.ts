/**
 * Key points of an article, written by the same model that translates (local Ollama or a cloud API).
 * Cached in the translations table under the language key `summary:<lang>`, keyed by the article text,
 * so a summary is made once per text and shared by every device.
 */
import type { App } from "../app.ts";
import { langName, sourceKey } from "../../shared/translate.ts";
import { sha1 } from "../util/text.ts";
import { complete } from "./engine.ts";

export interface Summary {
  points: string[];
  model: string;
  cached: boolean;
}

const MIN_CHARS = 400;
// Keep the prompt inside an 8k context: CJK is ~1 token per character, Latin text ~4 characters per token.
const MAX_TOKENS = 5500;

function clip(text: string): string {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += /[　-鿿가-힯]/.test(text[i]) ? 1 : 0.25;
    if (tokens > MAX_TOKENS) return `${text.slice(0, i)}…`;
  }
  return text;
}

const prompt = (lang: string) =>
  `You summarize articles for a busy reader. Write 3 to 5 key points in ${langName(lang)}, most important first.
Each point is one short sentence with the concrete fact, claim or number, not a vague topic.
Output only the points, one per line, each starting with "- ". No title, no introduction, no closing remark.`;

export function parsePoints(reply: string): string[] {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    // list markers ("- ", "• ", "1. ", "2)", "3、"), possibly stacked; "3.5 亿" keeps its number
    .map((l) => l.replace(/^\s*(?:(?:[-*•·]|\d{1,2}(?:[.)](?=\s)|、))\s*)+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .slice(0, 6);
}

const inflight = new Map<string, Promise<Summary>>();

/** The summary for `text`, from the cache, or generated when `generate` is set (null otherwise). */
export async function summarize(app: App, title: string, text: string, opts: { generate?: boolean; fresh?: boolean } = {}): Promise<Summary | null> {
  const cfg = app.settings.all().translate;
  const lang = `summary:${cfg.targetLang}`;
  const body = clip(sourceKey(text));
  if (body.length < MIN_CHARS) throw new Error("文章太短，不需要要点");
  const hash = sha1(body);
  if (opts.fresh) app.translations.forget([hash], lang);
  const hit = app.translations.get([hash], lang).get(hash);
  if (hit) {
    try {
      const saved = JSON.parse(hit) as { points: string[]; model: string };
      return { ...saved, cached: true };
    } catch {
      /* fall through and regenerate */
    }
  }
  if (!opts.generate) return null;
  const running = inflight.get(hash);
  if (running) return running;
  const job = (async () => {
    const reply = await complete(cfg, prompt(cfg.targetLang), `${title ? `Title: ${title}\n\n` : ""}${body}`);
    const points = parsePoints(reply);
    if (!points.length) throw new Error("模型没有给出要点");
    app.translations.put(hash, lang, JSON.stringify({ points, model: cfg.model }), cfg.model);
    return { points, model: cfg.model, cached: false };
  })().finally(() => inflight.delete(hash));
  inflight.set(hash, job);
  return job;
}
