/**
 * Translation jobs. The reader sends the texts of an article's blocks; cached translations come back at once and
 * the rest are translated in the background, a few blocks per model request, reporting progress over the event
 * stream. One job runs at a time (a local model has one GPU), and the job someone looked at last goes first.
 */
import type { App } from "../app.ts";
import type { TranslationJob } from "../../shared/types.ts";
import { sourceKey } from "../../shared/translate.ts";
import { sha1 } from "../util/text.ts";
import { logger } from "../util/log.ts";
import { translateBatch } from "./engine.ts";

const log = logger("translate");
const MAX_TEXTS = 1500;
const MAX_TEXT = 6000;
const IDLE_MS = 60 * 60_000;

interface Job {
  id: string;
  lang: string;
  texts: string[];
  hashes: string[];
  items: (string | null)[];
  error: string | null;
  model: string;
  touchedAt: number;
}

const jobs = new Map<string, Job>();
let running = false;

const snapshot = (j: Job): TranslationJob => ({
  id: j.id,
  lang: j.lang,
  total: j.items.length,
  done: j.items.filter((t) => t !== null).length,
  items: j.items,
  error: j.error,
  model: j.model,
});

/** Start (or resume) translating `texts`; returns what is known so far. `fresh` drops cached translations first. */
export function requestTranslation(app: App, rawTexts: string[], opts: { lang?: string; fresh?: boolean } = {}): TranslationJob {
  const cfg = app.settings.all().translate;
  const lang = opts.lang || cfg.targetLang;
  const texts = rawTexts.slice(0, MAX_TEXTS).map((t) => sourceKey(String(t)).slice(0, MAX_TEXT));
  const hashes = texts.map((t) => sha1(t));
  const id = sha1(`${lang}\n${hashes.join(",")}`).slice(0, 20);
  if (opts.fresh) {
    app.translations.forget(hashes, lang);
    jobs.delete(id);
  }
  let job = jobs.get(id);
  if (job?.error) job = undefined; // asking again after a failure = retry
  if (!job) {
    const cached = app.translations.get([...new Set(hashes)], lang);
    job = { id, lang, texts, hashes, items: hashes.map((h, i) => (texts[i] ? (cached.get(h) ?? null) : "")), error: null, model: cfg.model, touchedAt: Date.now() };
    jobs.set(id, job);
  }
  job.touchedAt = Date.now();
  prune();
  kick(app);
  return snapshot(job);
}

export function getTranslation(id: string): TranslationJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.touchedAt = Date.now();
  return snapshot(job);
}

function prune(): void {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, j] of jobs) if (j.touchedAt < cutoff) jobs.delete(id);
}

const pending = (j: Job) => !j.error && j.items.some((t) => t === null);

function kick(app: App): void {
  if (running) return;
  running = true;
  void (async () => {
    try {
      for (;;) {
        const job = [...jobs.values()].filter(pending).sort((a, b) => b.touchedAt - a.touchedAt)[0];
        if (!job) break;
        await step(app, job);
      }
    } finally {
      running = false;
    }
  })();
}

/** Translate the next chunk of a job. */
async function step(app: App, job: Job): Promise<void> {
  const cfg = app.settings.all().translate;
  const local = cfg.provider === "ollama";
  // A small first chunk puts the title and opening paragraphs on screen within seconds.
  const first = job.items.every((t) => !t);
  const maxChars = first ? 400 : local ? 1600 : 5000;
  const maxCount = local ? 16 : 40;
  // Same text twice in one article is translated once.
  const chunk: string[] = [];
  const chunkHashes: string[] = [];
  let size = 0;
  for (let i = 0; i < job.items.length; i++) {
    if (job.items[i] !== null || chunkHashes.includes(job.hashes[i])) continue;
    if (chunk.length && (size + job.texts[i].length > maxChars || chunk.length >= maxCount)) break;
    chunk.push(job.texts[i]);
    chunkHashes.push(job.hashes[i]);
    size += job.texts[i].length;
  }
  const started = Date.now();
  try {
    const out = await translateBatch(cfg, chunk, job.lang);
    chunkHashes.forEach((h, k) => {
      app.translations.put(h, job.lang, out[k], cfg.model);
      job.hashes.forEach((hh, i) => {
        if (hh === h) job.items[i] = out[k];
      });
    });
    job.model = cfg.model;
    log.debug(`translated ${chunk.length} block(s), ${size} chars in ${Date.now() - started} ms with ${cfg.model}`);
  } catch (err) {
    job.error = (err as Error).message;
    log.warn("translation failed", job.error);
  }
  const s = snapshot(job);
  app.events.emit({ type: "translation", id: job.id, done: s.done, total: s.total, error: job.error });
}
