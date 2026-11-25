import type { App } from "../app.ts";
import type { PluginAccount } from "../feeds/plugin-api.ts";
import { LoginExpiredError } from "../feeds/plugin-api.ts";
import { getPlugin } from "../feeds/plugins.ts";
import { serviceById } from "./services.ts";
import type { FeedConfig, FeedKind } from "../../shared/types.ts";

/** Keep a sign-in a plugin renewed along the way (a new portal session), so the next request starts from it. */
export function keepRenewed(app: App, account: PluginAccount | null, before: string): void {
  if (account?.jar && JSON.stringify(account.jar) !== before) app.accounts.updateSecret(account.id, { token: account.token, cookie: account.cookie, jar: account.jar });
}

/** A subscription that reads with an account: its articles' pages show nothing to a server without that sign-in. */
export async function readsWithAccount(app: App, feed: { kind: FeedKind; url: string; config: FeedConfig } | undefined): Promise<boolean> {
  if (feed?.kind !== "plugin") return false;
  const plugin = await getPlugin(app.cfg.pluginsDir, feed.config.plugin?.id || feed.url).catch(() => null);
  return !!plugin?.account;
}

/**
 * The sign-in to send for a picture or file at a platform's own address (Canvas files), when one is connected
 * and the path is one of the platform's files; null for everything else, so no other address ever gets it.
 */
export function assetHeaders(app: App, url: string): Record<string, string> | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const a of app.accounts.atOrigin(u.origin)) {
    const service = serviceById(a.service);
    if (a.status === "expired" || !service?.assets?.test(u.pathname)) continue;
    const c = app.accounts.credential(a.id);
    if (c) return service.headers(c);
  }
  return null;
}

/**
 * The account a plugin subscription reads with: the one its config names, or else the one signed in to the
 * plugin's platform. null when the plugin needs none (or none is connected yet: the plugin then says so).
 */
export async function accountFor(app: App, pluginId: string, accountId?: number): Promise<PluginAccount | null> {
  const plugin = await getPlugin(app.cfg.pluginsDir, pluginId).catch(() => null);
  if (!plugin?.account) return null;
  const id = accountId ?? app.accounts.list().find((a) => a.service === plugin.account)?.id;
  if (!id) return null;
  const c = app.accounts.credential(id);
  if (!c) throw new Error("这个订阅源用的账号已经删除了：先在 设置 → 账号 里重新连接");
  // a sign-in the platform refused is not tried again until the user signs in anew
  if (c.account.status === "expired") throw new LoginExpiredError(`${serviceById(c.account.service)?.name || c.account.service}的登录已过期，请在 设置 → 账号 里重新登录`);
  return { id: c.account.id, origin: c.account.origin, name: c.account.name, token: c.token, cookie: c.cookie, jar: c.jar };
}
