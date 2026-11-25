import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import type { AcornPlugin, PluginAccount, PluginContext, PluginState } from "./plugin-api.ts";
import { LoginExpiredError } from "./plugin-api.ts";
import type { PluginInfo } from "../../shared/types.ts";
import type { ParsedItem } from "./parse.ts";
import { BUILTIN } from "./builtin/index.ts";
import { decodeBody, fetchText, httpGet } from "../util/http.ts";
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

const info = (p: AcornPlugin, builtin: boolean): PluginInfo => ({ id: p.id, name: p.name, description: p.description || "", params: p.params || [], builtin: builtin || undefined, account: p.account,
  // built-ins that sign in list under 登录后订阅 unless they say otherwise
  group: builtin ? p.group || (p.account ? "account" : "general") : undefined,
});

export async function listPlugins(dir: string): Promise<PluginInfo[]> {
  // the platforms Acorn signs in to come first; a file in plugins/ cannot take their ids
  const out: PluginInfo[] = BUILTIN.map((p) => info(p, true));
  for (const f of files(dir)) {
    const l = await load(dir, f);
    if (l.plugin && BUILTIN.some((b) => b.id === l.plugin!.id)) continue;
    if (l.plugin) out.push(info(l.plugin, false));
    else out.push({ id: f.replace(/\.\w+$/, ""), name: f, description: "", params: [], error: l.error });
  }
  return out;
}

export async function getPlugin(dir: string, id: string): Promise<AcornPlugin> {
  const builtin = BUILTIN.find((p) => p.id === id);
  if (builtin) return builtin;
  for (const f of files(dir)) {
    const l = await load(dir, f);
    if (l.plugin?.id === id) return l.plugin;
  }
  throw new Error(`找不到插件 ${id}`);
}

/** A state for one run only (previews, choices). */
export function memoryState(): PluginState {
  const m = new Map<string, unknown>();
  return { get: <T,>(k: string) => m.get(k) as T | undefined, set: (k, v) => void m.set(k, v) };
}

/** What a plugin runs with; also how other parts of Acorn read through a built-in plugin's helpers (the class calendar). */
export function pluginContext(id: string, params: Record<string, string>, userAgent: string, account: PluginAccount | null, state: PluginState = memoryState()): PluginContext {
  return {
    params,
    state,
    fetchText: async (url, opts = {}) => (await fetchText(url, { userAgent, headers: opts.headers, referer: opts.referer, cookie: opts.cookie })).text,
    fetchJson: async (url, opts = {}) =>
      JSON.parse((await fetchText(url, { userAgent, accept: "application/json", headers: opts.headers, referer: opts.referer, cookie: opts.cookie })).text),
    request: async (url, opts = {}) => {
      const res = await httpGet(url, { userAgent, headers: opts.headers, referer: opts.referer, cookie: opts.cookie, accept: opts.accept, timeoutMs: 30_000 });
      return { status: res.status, ok: res.ok, url: res.url, headers: res.headers, text: decodeBody(res.body, res.contentType) };
    },
    account,
    loginExpired: (message) => {
      throw new LoginExpiredError(message);
    },
    parseHTML: (html) => parseHTML(html) as unknown as { document: Document },
    absolutize,
    parseDate: (v) => parseLooseDate(v),
    log: (msg) => log.info(`[${id}] ${msg}`),
  };
}

/** A plugin that reads with an account cannot run without one. */
function needAccount(plugin: AcornPlugin, account: PluginAccount | null): void {
  if (plugin.account && !account) throw new Error(`「${plugin.name}」要先连接账号：设置 → 账号`);
}

/** The choices of a plugin parameter that come from the signed-in account (the 星球 it joined…). */
export async function pluginChoices(dir: string, id: string, key: string, userAgent: string, account: PluginAccount | null) {
  const plugin = await getPlugin(dir, id);
  needAccount(plugin, account);
  return plugin.choices ? plugin.choices(pluginContext(id, {}, userAgent, account), key) : [];
}

export async function runPlugin(dir: string, id: string, params: Record<string, string>, userAgent: string, account: PluginAccount | null = null, state?: PluginState) {
  const plugin = await getPlugin(dir, id);
  needAccount(plugin, account);
  const result = await plugin.fetch(pluginContext(id, params, userAgent, account, state));
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
