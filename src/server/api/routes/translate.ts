import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import { getTranslation, requestTranslation } from "../../translate/index.ts";
import { DEFAULT_BASE, TranslateError, translateBatch } from "../../translate/engine.ts";
import { summarize } from "../../translate/summary.ts";
import { snapshotText } from "../../archive/capture.ts";
import { htmlToText } from "../../util/text.ts";

const REQUEST = z.object({ texts: z.array(z.string()).max(1500), lang: z.string().max(20).optional(), fresh: z.boolean().optional() });

export function registerTranslate(r: Hono, app: App): void {
  r.post("/api/translate", async (c) => {
    const body = REQUEST.parse(await c.req.json());
    return c.json(requestTranslation(app, body.texts, { lang: body.lang, fresh: body.fresh }));
  });

  r.get("/api/translate/models", async (c) => {
    const cfg = app.settings.all().translate;
    const base = (cfg.baseUrl || DEFAULT_BASE[cfg.provider]).replace(/\/+$/, "");
    try {
      if (cfg.provider === "ollama") {
        const d = (await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: { name: string }[] };
        return c.json({ models: (d.models || []).map((m) => m.name) });
      }
      const headers: Record<string, string> = cfg.provider === "anthropic" ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${cfg.apiKey}` };
      const d = (await (await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) })).json()) as { data?: { id: string }[] };
      return c.json({ models: (d.data || []).map((m) => m.id).sort() });
    } catch {
      return c.json({ models: [] });
    }
  });

  r.post("/api/translate/test", async (c) => {
    const cfg = app.settings.all().translate;
    const started = Date.now();
    try {
      const [text] = await translateBatch(cfg, ["The squirrel buries acorns in autumn and forgets half of them; the forgotten ones grow into the next forest."], cfg.targetLang);
      return c.json({ ok: true, text, ms: Date.now() - started, model: cfg.model });
    } catch (err) {
      if (err instanceof TranslateError) return c.json({ ok: false, error: err.message, ms: Date.now() - started }, 200);
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
