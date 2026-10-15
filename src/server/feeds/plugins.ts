import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { AcornPlugin, PluginContext } from "./plugin-api.ts";
import type { PluginInfo } from "../../shared/types.ts";
import type { ParsedItem } from "./parse.ts";
import { fetchText } from "../util/http.ts";
import { absolutize } from "../util/url.ts";
import { parseLooseDate } from "../util/dates.ts";
import { sha1 } from "../util/text.ts";
import { logger } from "../util/log.ts";

const log = logger("plugins");

interface Loaded {
  mtime: number;
  plugin: AcornPlugin | null;
  error?: string;
}

const cache = new Map<string, Loaded>();

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("_"));
}

async function load(dir: string, file: string): Promise<Loaded> {
  const full = path.join(dir, file);
  const mtime = statSync(full).mtimeMs;
  const hit = cache.get(full);
  if (hit && hit.mtime === mtime) return hit;
  let entry: Loaded;
  try {
    const mod = await import(`${pathToFileURL(full).href}?v=${mtime}`);
    const plugin = (mod.default || mod.plugin) as AcornPlugin;
    if (!plugin?.id || typeof plugin.fetch !== "function") throw new Error("插件需要 default export { id, name, fetch }");
    entry = { mtime, plugin };
  } catch (err) {
    entry = { mtime, plugin: null, error: (err as Error).message };
    log.warn(`failed to load plugin ${file}`, err);
  }
  cache.set(full, entry);
  return entry;
}

export async function listPlugins(dir: string): Promise<PluginInfo[]> {
  const out: PluginInfo[] = [];
  for (const f of files(dir)) {
    const l = await load(dir, f);
    if (l.plugin) out.push({ id: l.plugin.id, name: l.plugin.name, description: l.plugin.description || "", params: l.plugin.params || [] });
    else out.push({ id: f.replace(/\.\w+$/, ""), name: f, description: "", params: [], error: l.error });
  }
  return out;
}

export async function getPlugin(dir: string, id: string): Promise<AcornPlugin> {
  for (const f of files(dir)) {
    const l = await load(dir, f);
    if (l.plugin?.id === id) return l.plugin;
  }
  throw new Error(`找不到插件 ${id}`);
}

export async function runPlugin(dir: string, id: string, params: Record<string, string>, userAgent: string) {
  const plugin = await getPlugin(dir, id);
  const ctx: PluginContext = {
    params,
    fetchText: async (url, opts = {}) => (await fetchText(url, { userAgent, headers: opts.headers, referer: opts.referer, cookie: opts.cookie })).text,
    fetchJson: async (url, opts = {}) =>
      JSON.parse((await fetchText(url, { userAgent, accept: "application/json", headers: opts.headers, referer: opts.referer, cookie: opts.cookie })).text),
    parseHTML: (html) => parseHTML(html) as unknown as { document: Document },
    absolutize,
    parseDate: (v) => parseLooseDate(v),
    log: (msg) => log.info(`[${id}] ${msg}`),
  };
  const result = await plugin.fetch(ctx);
  const items: ParsedItem[] = (result.items || [])
    .filter((it) => it && it.title)
    .map((it) => {
      const publishedAt = parseLooseDate(it.publishedAt);
      return {
        guid: it.guid || it.url || `h:${sha1(`${it.title}|${publishedAt ?? ""}`)}`,
        url: it.url || null,
        title: it.title,
        author: it.author || null,
        contentHtml: it.content || null,
        summary: it.summary || null,
        image: it.image || null,
        publishedAt,
      };
    });
  return { title: result.title || plugin.name, siteUrl: result.siteUrl || null, description: result.description || plugin.description || null, items };
}
