import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import type { ModelTest, TranslateSettings } from "../../../shared/types.ts";
import { isMaskedKey, keyTarget, REASONING_CHOICES } from "../../../shared/ai.ts";
import { getTranslation, requestTranslation } from "../../translate/index.ts";
import { parseReply, TranslateError, trySentence } from "../../translate/engine.ts";
import { listModels, modelInfo } from "../../translate/models.ts";
import { summarize } from "../../translate/summary.ts";
import { normalizeTranslate } from "../../store/settings.ts";
import { snapshotText } from "../../archive/capture.ts";
import { htmlToText } from "../../util/text.ts";

const REQUEST = z.object({ texts: z.array(z.string()).max(1500), lang: z.string().max(20).optional(), fresh: z.boolean().optional() });

/** The settings page's unsaved edits of the AI service. */
const DRAFT = z.object({
  provider: z.enum(["ollama", "openai", "anthropic"]),
  preset: z.string().max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  model: z.string().max(300).optional(),
  reasoning: z.enum(REASONING_CHOICES as [string, ...string[]]).optional(),
  contextLength: z.number().int().min(0).max(100_000_000).optional(),
  extraBody: z.string().max(20_000).optional(),
});

/**
 * The saved settings with the draft on top. A masked (or missing) key stands for the saved key, but only for the
 * service and address it was saved for: a key is never sent anywhere it was not entered for.
 */
function draftSettings(app: App, body: unknown): TranslateSettings {
  const saved = app.settings.all().translate;
  const d = DRAFT.parse(body);
  const merged = normalizeTranslate({ ...saved, ...d, preset: d.preset ?? "" } as TranslateSettings);
  if (d.apiKey === undefined || isMaskedKey(d.apiKey)) merged.apiKey = keyTarget(merged) === keyTarget(saved) ? saved.apiKey : "";
  return merged;
}

export function registerTranslate(r: Hono, app: App): void {
  r.post("/api/translate", async (c) => {
    const body = REQUEST.parse(await c.req.json());
    return c.json(requestTranslation(app, body.texts, { lang: body.lang, fresh: body.fresh }));
  });

  // The models of the saved service, or (POST) of the one the settings page is filling in, before it is saved.
  r.get("/api/translate/models", async (c) => c.json(await listModels(app, app.settings.all().translate)));
  r.post("/api/translate/models", async (c) => c.json(await listModels(app, draftSettings(app, await c.req.json()))));

  // One sentence through the saved configuration, or (with a body) through the draft.
  r.post("/api/translate/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const cfg = body && Object.keys(body).length ? draftSettings(app, body) : app.settings.all().translate;
    const started = Date.now();
    try {
      const info = await modelInfo(app, cfg);
      const reply = await trySentence(cfg, info);
      const text = (parseReply(reply.text, 1) ?? [reply.text.trim()])[0];
      if (!text) throw new TranslateError("模型没有给出译文");
      const out: ModelTest = { ok: true, text, ms: Date.now() - started, model: cfg.model, reasoned: reply.reasoned, reasoningTokens: reply.reasoningTokens, sent: reply.sent, info };
      return c.json(out);
    } catch (err) {
      if (err instanceof TranslateError) return c.json({ ok: false, error: err.message, ms: Date.now() - started, model: cfg.model } satisfies ModelTest, 200);
      throw err;
    }
  });

  const SUMMARY = z.object({ entryId: z.number().int().optional(), archiveId: z.number().int().optional(), generate: z.boolean().optional(), fresh: z.boolean().optional() });
  r.post("/api/summary", async (c) => {
    const body = SUMMARY.parse(await c.req.json());
    let title = "";
    let text = "";
    if (body.entryId) {
      const row = app.entries.row(body.entryId);
      if (!row) return c.json({ error: "not_found", message: "没有这篇文章" }, 404);
      title = row.title;
      text = htmlToText(row.full_content || row.content);
    } else if (body.archiveId) {
      const a = app.archives.row(body.archiveId);
      const snap = a ? app.archives.latestSnapshot(a.id) : undefined;
      if (!a || !snap) return c.json({ error: "not_found", message: "没有这份存档" }, 404);
      title = a.title;
      text = snapshotText(app, snap.dir);
    } else return c.json({ error: "bad_request", message: "需要 entryId 或 archiveId" }, 400);
    try {
      return c.json({ summary: await summarize(app, title, text, body) });
    } catch (err) {
      return c.json({ error: "summary", message: (err as Error).message }, err instanceof TranslateError ? 502 : 422);
    }
  });

  r.get("/api/translate/:id", (c) => {
    const job = getTranslation(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "not_found", message: "翻译任务已过期，请重新发起" }, 404);
  });
}
