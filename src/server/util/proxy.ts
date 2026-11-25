/**
 * The way out to the internet. Where a proxy is needed (mainland China: Nikkei, Reddit, YouTube, OpenAI…) every
 * outbound request of the server goes through it — feeds, pages, images, plugins, translation — the way the
 * user's browser and other apps already do, while local services (Ollama, RSSHub, we-mp-rss) stay direct.
 * Node 24 routes fetch and http(s) through a proxy set at run time (http.setGlobalProxyFromEnv).
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { NetworkSettings } from "../../shared/types.ts";
import { logger } from "./log.ts";

const log = logger("network");

export const DEFAULT_BYPASS = "localhost, 127.0.0.1, ::1, .local";

type SetProxy = (env: Record<string, string>) => () => void;
const setProxy = (http as unknown as { setGlobalProxyFromEnv?: SetProxy }).setGlobalProxyFromEnv;

/** This Node can route requests through a proxy (Node 24 and later). */
export const proxySupported = typeof setProxy === "function";

/** The proxy this computer uses: from the environment, or (macOS) the system's network settings, as Clash and others set it. */
export function systemProxy(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) return fromEnv.trim();
  if (process.platform !== "darwin") return "";
  try {
    const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 });
    const v = (k: string) => out.match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`))?.[1];
    if (v("HTTPSEnable") === "1" && v("HTTPSProxy")) return `http://${v("HTTPSProxy")}:${v("HTTPSPort") || 80}`;
    if (v("HTTPEnable") === "1" && v("HTTPProxy")) return `http://${v("HTTPProxy")}:${v("HTTPPort") || 80}`;
    if (v("SOCKSEnable") === "1" && v("SOCKSProxy")) return `socks5://${v("SOCKSProxy")}:${v("SOCKSPort") || 1080}`;
  } catch {
    /* no system proxy to read */
  }
  return "";
}

/** The proxy the settings come down to: "" for none. */
export function effectiveProxy(n: NetworkSettings, env: NodeJS.ProcessEnv = process.env): string {
  if (n.proxy === "off") return "";
  if (n.proxy === "manual") return n.url.trim();
  return systemProxy(env);
}

let undo: (() => void) | null = null;
let active = "";

/** Route the server's requests as the settings say. Returns the proxy now in use ("" for direct). */
export function applyNetwork(n: NetworkSettings): string {
  const proxy = effectiveProxy(n);
  if (proxy === active && (undo !== null) === !!proxy) return active;
  // each change goes back to direct first: a newer setting does not replace an older one, it stacks on it
  if (undo) {
    undo();
    undo = null;
  }
  active = "";
  if (proxy && setProxy) {
    try {
      undo = setProxy({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: n.bypass || DEFAULT_BYPASS });
      active = proxy;
    } catch (err) {
      log.warn(`proxy ${proxy} not usable`, (err as Error).message);
    }
  }
  if (proxy && !setProxy) log.warn("this Node cannot use a proxy (Node 24 or later is needed)");
  log.info(active ? `outbound requests go through ${active}` : "outbound requests go direct");
  return active;
}

/** The proxy in use right now ("" for direct). */
export const activeProxy = (): string => active;

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** A network failure in words: a proxy that is not running, a name the network cannot resolve, a site out of reach. */
export function describeNetworkError(code: string | undefined, url: string, detail = ""): string | null {
  const h = host(url);
  if (code === "ECONNREFUSED" && active && detail.includes(host(active))) return `连不上代理 ${host(active)}：代理软件没有运行（设置 → 网络）`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ESERVFAIL")
    return active ? `找不到 ${h}：地址写错了，或者代理也解析不了它` : `找不到 ${h}：域名解析失败。在中国大陆访问境外网站，要在 设置 → 网络 里用上代理`;
  if ((code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") && !active) return `连接 ${h} 被中断了：如果它在境外，可能要在 设置 → 网络 里用上代理`;
  return null;
}
