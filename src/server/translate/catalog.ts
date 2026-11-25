/**
 * The models.dev catalog: context windows, reasoning controls, prices and temperature support for thousands of
 * models across a hundred services. Most services list only model ids; this fills in the rest (Hermes Agent uses
 * the same source). Downloaded at most once a day, trimmed to what Acorn reads, and kept in data/cache, so it keeps
 * working when models.dev cannot be reached.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import type { ModelInfo, ReasoningSpec } from "../../shared/types.ts";
import { EFFORTS, isEffort } from "../../shared/ai.ts";
import { logger } from "../util/log.ts";

const log = logger("catalog");
const MAX_AGE = 24 * 3_600_000;

interface Option {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

export interface Entry {
  name?: string;
  reasoning?: boolean;
  options?: Option[];
  temperature?: boolean;
  context?: number;
  output?: number;
  cost?: { input?: number; output?: number };
  released?: string;
}

export type Catalog = Record<string, { api?: string; models: Record<string, Entry> }>;

let memory: { at: number; data: Catalog } | null = null;
let loading: Promise<Catalog | null> | null = null;

const file = (app: App) => path.join(app.cfg.cacheDir, "models-catalog.json");

/** models.dev's api.json, cut down to the fields Acorn uses (a sixth of the size). */
export function trimCatalog(raw: unknown): Catalog {
  const out: Catalog = {};
  for (const [pid, p] of Object.entries((raw || {}) as Record<string, { api?: string; models?: Record<string, Record<string, any>> }>)) {
    const models: Record<string, Entry> = {};
    for (const [mid, m] of Object.entries(p?.models || {})) {
      if (!m || m.status === "deprecated") continue;
      models[mid] = {
        name: m.name,
        reasoning: m.reasoning,
        options: Array.isArray(m.reasoning_options) ? m.reasoning_options : undefined,
        temperature: m.temperature,
        context: m.limit?.context || undefined,
        output: m.limit?.output || undefined,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
        released: m.release_date,
      };
    }
    out[pid] = { api: p?.api, models };
  }
  return out;
}

async function download(app: App): Promise<Catalog | null> {
  const res = await fetch(app.cfg.modelsCatalog, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": app.cfg.feedUserAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = trimCatalog(await res.json());
  if (!Object.keys(data).length) throw new Error("empty catalog");
  writeFileSync(file(app), JSON.stringify(data));
  return data;
}

/** The catalog, from memory, the copy on disk, or models.dev; null when there is none at all. */
export function loadCatalog(app: App): Promise<Catalog | null> {
  if (!app.cfg.modelsCatalog) return Promise.resolve(null);
  if (memory && Date.now() - memory.at < MAX_AGE) return Promise.resolve(memory.data);
  if (loading) return loading;
  loading = (async () => {
    const f = file(app);
    let stale: Catalog | null = memory?.data ?? null;
    if (existsSync(f)) {
      try {
        const saved = JSON.parse(readFileSync(f, "utf8")) as Catalog;
        const at = statSync(f).mtimeMs;
        if (Date.now() - at < MAX_AGE) {
          memory = { at, data: saved };
          return saved;
        }
        stale = saved;
      } catch {
        /* a damaged copy is downloaded again */
      }
    }
    try {
      const data = await download(app);
      memory = { at: Date.now(), data: data! };
      return data;
    } catch (err) {
      log.debug("models.dev unavailable", (err as Error).message);
      // an old copy is still far better than none; try the network again in an hour
      if (stale) memory = { at: Date.now() - MAX_AGE + 3_600_000, data: stale };
      return stale;
    }
  })().finally(() => (loading = null));
  return loading;
}

const host = (url: string | undefined): string => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};

/** The catalog provider whose API lives at this address (a custom endpoint that is really DeepSeek or Kimi). */
export function providerForUrl(cat: Catalog, baseUrl: string): string | null {
  const h = host(baseUrl);
  if (!h) return null;
  const hit = Object.entries(cat).find(([, p]) => host(p.api) === h);
  return hit ? hit[0] : null;
}

// Where to look for a model whose service is not in the catalog (relays, One API, a model id typed by hand):
// the makers' own entries first, so a relay's "deepseek-flash" gets DeepSeek's capabilities.
const MAKERS = ["deepseek", "anthropic", "openai", "google", "alibaba-cn", "moonshotai-cn", "zhipuai", "volcengine", "xiaomi", "minimax", "openrouter"];

const bare = (id: string): string =>
  id
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:(free|beta|extended|nitro|floor|thinking|batch)$/, "");

/** A model's entry: exact id first, then the same model under another vendor prefix or suffix. */
export function catalogEntry(cat: Catalog, providers: (string | null | undefined)[], id: string): Entry | null {
  const order = [...new Set([...providers.filter((p): p is string => !!p), ...MAKERS])];
  for (const p of order) {
    const m = cat[p]?.models;
    if (m?.[id]) return m[id];
  }
  const want = bare(id);
  if (!want) return null;
  for (const p of order) {
    const models = cat[p]?.models || {};
    const k = Object.keys(models).find((x) => bare(x) === want);
    if (k) return models[k];
  }
  return null;
}

/** The reasoning controls models.dev lists, in Acorn's terms. */
export function specFromEntry(e: Entry): ReasoningSpec | false | null {
  if (e.reasoning === false) return false;
  if (e.reasoning !== true) return null;
  const opts = e.options || [];
  const effort = opts.find((o) => o.type === "effort");
  const budget = opts.find((o) => o.type === "budget_tokens");
  return {
    toggle: opts.some((o) => o.type === "toggle"),
    efforts: (effort?.values || []).filter(isEffort).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b)),
    budget: budget ? { min: budget.min || undefined, max: budget.max || undefined } : null,
  };
}

export function infoFromEntry(id: string, e: Entry): ModelInfo {
  return {
    id,
    name: e.name,
    context: e.context,
    maxOutput: e.output,
    reasoning: specFromEntry(e),
    temperature: e.temperature,
    price: e.cost && typeof e.cost.input === "number" && typeof e.cost.output === "number" ? { input: e.cost.input, output: e.cost.output } : undefined,
    source: "catalog",
  };
}

/** Fill in what a service's own listing left out. The service's own figures win. */
export function enrich(info: ModelInfo, e: Entry | null): ModelInfo {
  if (!e) return info;
  const c = infoFromEntry(info.id, e);
  return {
    ...info,
    name: info.name || c.name,
    context: info.context ?? c.context,
    maxOutput: info.maxOutput ?? c.maxOutput,
    reasoning: info.reasoning ?? c.reasoning,
    temperature: info.temperature ?? c.temperature,
    price: info.price ?? c.price,
    source: info.source ?? (info.context || info.reasoning ? "service" : "catalog"),
  };
}

/** Newest first, for listing models a service has no endpoint for. */
export function catalogModels(cat: Catalog, provider: string): ModelInfo[] {
  return Object.entries(cat[provider]?.models || {})
    .sort((a, b) => (b[1].released || "").localeCompare(a[1].released || "") || a[0].localeCompare(b[0]))
    .map(([id, e]) => infoFromEntry(id, e));
}

export function releasedAt(cat: Catalog | null, providers: (string | null | undefined)[], id: string): string {
  return (cat && catalogEntry(cat, providers, id)?.released) || "";
}
