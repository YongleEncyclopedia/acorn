/**
 * Which RSSHub route serves a page: RSSHub's radar rules (the ones its browser extension uses) map addresses such
 * as space.bilibili.com/2267573 or weibo.com/u/123 to routes. The rules come from the configured RSSHub
 * instance when it serves them, else from the copy RSSHub publishes; downloaded at most once a day and kept in
 * data/cache, like the models catalog.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import type { RsshubMatch } from "../../shared/types.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { rsshubBase } from "./source.ts";
import { logger } from "../util/log.ts";

const log = logger("radar");
const MAX_AGE = 24 * 3_600_000;
const PUBLISHED = ["https://cdn.jsdelivr.net/gh/DIYgod/RSSHub@gh-pages/build/radar-rules.json", "https://rsshub.js.org/build/radar-rules.json"];

interface Rule {
  title: string;
  docs?: string;
  source: string[];
  target: string;
}
/** domain → subdomain ("." for none) → rules; "_name" is the site's name. */
export type RadarRules = Record<string, Record<string, Rule[] | string>>;

let memory: { at: number; rules: RadarRules } | null = null;
let loading: Promise<RadarRules | null> | null = null;

const file = (app: App) => path.join(app.cfg.cacheDir, "radar-rules.json");

async function download(app: App): Promise<RadarRules> {
  const base = rsshubBase(app);
  // rsshub.app refuses most programs now; its rules are the published ones anyway
  const sources = [...(base && !/(^|\.)rsshub\.app$/i.test(new URL(base).hostname) ? [`${base}/api/radar/rules`] : []), ...PUBLISHED];
  let last: unknown = null;
  for (const url of sources) {
    try {
      const res = await httpGet(url, { userAgent: app.cfg.feedUserAgent, accept: "application/json", timeoutMs: 25_000, maxBytes: 20 * 1024 * 1024 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rules = JSON.parse(decodeBody(res.body, res.contentType)) as RadarRules;
      if (Object.keys(rules).length < 50) throw new Error("too few rules");
      writeFileSync(file(app), JSON.stringify(rules));
      return rules;
    } catch (err) {
      last = err;
      log.debug(`radar rules not from ${url}`, (err as Error).message);
    }
  }
  throw last instanceof Error ? last : new Error("no radar rules");
}

/** The rules, from memory, the copy on disk, or the network; null when there are none at all. */
export function loadRadar(app: App): Promise<RadarRules | null> {
  if (memory && Date.now() - memory.at < MAX_AGE) return Promise.resolve(memory.rules);
  if (loading) return loading;
  loading = (async () => {
    let stale: RadarRules | null = memory?.rules ?? null;
    const f = file(app);
    if (existsSync(f)) {
      try {
        const rules = JSON.parse(readFileSync(f, "utf8")) as RadarRules;
        const at = statSync(f).mtimeMs;
        if (Date.now() - at < MAX_AGE) {
          memory = { at, rules };
          return rules;
        }
        stale = rules;
      } catch {
        /* a damaged copy is downloaded again */
      }
    }
    try {
      const rules = await download(app);
      memory = { at: Date.now(), rules };
      return rules;
    } catch {
      // an old copy is still useful; the network is tried again in an hour
      if (stale) memory = { at: Date.now() - MAX_AGE + 3_600_000, rules: stale };
      return stale;
    }
  })().finally(() => (loading = null));
  return loading;
}

/** The rules if they come quickly: adding a source does not wait long for them. */
export const radarSoon = (app: App, ms = 6000): Promise<RadarRules | null> =>
  Promise.race([loadRadar(app).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms).unref())]);

// ───────────────────────── matching ─────────────────────────

/** A rule's path pattern ("/:uid", "/video/:bvid", "/a/hot/:id.html", "/:lang?/news", "/*") as a regular expression. */
function compile(pattern: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  let src = "";
  for (let i = 0; i < pattern.length; ) {
    const m = pattern.slice(i).match(/^:(\w+)([?*+])?/);
    if (m) {
      names.push(m[1]);
      if (m[2] === "?" && src.endsWith("\\/")) src = `${src.slice(0, -2)}(?:\\/([^/]+?))?`;
      else if (m[2] === "*" || m[2] === "+") src += "(.*)";
      else src += m[2] === "?" ? "([^/]*?)" : "([^/]+?)";
      i += m[0].length;
      continue;
    }
    const ch = pattern[i++];
    src += ch === "*" ? ".*" : ch.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
  }
  return { re: new RegExp(`^${src}\\/?$`, "i"), names };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The parameters a source pattern ("/films?showType=1", "/#/channel/:id") takes from an address, or null. */
function matchSource(source: string, u: URL): Record<string, string> | null {
  const [beforeHash, hash] = source.split("#");
  const [pathPart, query = ""] = beforeHash.split("?");
  const params: Record<string, string> = {};
  const take = (pattern: string, value: string) => {
    const { re, names } = compile(pattern || "/");
    const m = re.exec(value);
    if (!m) return false;
    names.forEach((n, i) => m[i + 1] && (params[n] = decode(m[i + 1])));
    return true;
  };
  if (!take(pathPart, u.pathname === "" ? "/" : u.pathname)) return null;
  for (const pair of query.split("&").filter(Boolean)) {
    const [k, v = ""] = pair.split("=");
    const got = u.searchParams.get(k);
    if (v.startsWith(":")) {
      if (got) params[v.slice(1).replace(/[?*+]$/, "")] = got;
      else if (!v.endsWith("?")) return null;
    } else if (got !== v) return null;
  }
  if (hash !== undefined && !take(hash, u.hash.replace(/^#/, "") || "/")) return null;
  return params;
}

/** A route with the page's parameters filled in; null when it needs one the page does not give. */
function fillTarget(target: string, params: Record<string, string>): string | null {
  let ok = true;
  const out = target.replace(/\/:(\w+)(\{[^}]*\})?([?*+])?/g, (m, name: string, _re: string, mod: string) => {
    const v = params[name];
    if (v) return `/${v}`;
    if (mod === "?" || mod === "*") return "";
    ok = false;
    return m;
  });
  return ok && !/:\w/.test(out) ? out : null;
}

/** The rule lists for a host: its subdomain's, with www and the bare domain standing in for each other. */
function rulesFor(rules: RadarRules, hostname: string): Rule[] {
  const labels = hostname.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join(".");
    const site = rules[domain];
    if (!site || typeof site !== "object") continue;
    const sub = labels.slice(0, i).join(".") || ".";
    const list = site[sub] ?? (sub === "www" ? site["."] : sub === "." ? site.www : undefined);
    return Array.isArray(list) ? list : [];
  }
  return [];
}

/** RSSHub routes that serve this address, the most specific first. */
export function matchRadar(rules: RadarRules, address: string): RsshubMatch[] {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return [];
  }
  // a public Telegram channel's page is t.me/<name>; RSSHub's rule is for t.me/s/<name>
  if (/^(www\.)?t\.me$/i.test(u.hostname) && /^\/[\w]{4,}\/?$/.test(u.pathname)) u = new URL(`https://t.me/s${u.pathname}`);
  const found: { m: RsshubMatch; score: number }[] = [];
  const seen = new Set<string>();
  for (const rule of rulesFor(rules, u.hostname)) {
    for (const source of rule.source) {
      const params = matchSource(source, u);
      if (!params) continue;
      const route = fillTarget(rule.target, params);
      if (!route || seen.has(route)) break;
      seen.add(route);
      // literal characters say how specific a pattern is ("/video/:id" over "/*")
      found.push({ m: { title: rule.title, route, docs: rule.docs }, score: source.replace(/:\w+[?*+]?|\*/g, "").length });
      break;
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 12).map((f) => f.m);
}

/** The routes for an address, when the rules can be had quickly. */
export async function radarFor(app: App, address: string): Promise<RsshubMatch[]> {
  const rules = await radarSoon(app);
  return rules ? matchRadar(rules, address) : [];
}
