import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import { getTranslation, requestTranslation } from "../../translate/index.ts";
import { DEFAULT_BASE, TranslateError, translateBatch } from "../../translate/engine.ts";

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

  r.get("/api/translate/:id", (c) => {
    const job = getTranslation(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "not_found", message: "翻译任务已过期，请重新发起" }, 404);
  });
}
