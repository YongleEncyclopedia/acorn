/**
 * WeChat Official Accounts through we-mp-rss (github.com/rachelos/we-mp-rss).
 * we-mp-rss logs into the WeChat MP backend and turns accounts into RSS: `/rss/fresh` lists every
 * subscribed account, `/feed/<id>.xml` carries one account's articles with full text.
 * Syncing mirrors that list as Acorn feeds, so subscribing in we-mp-rss is enough. Accounts removed
 * there stay here: their entries and archives are part of the user's library.
 */
import type { App } from "../app.ts";
import type { WechatBridgeSync } from "../../shared/types.ts";
import { fetchText } from "../util/http.ts";
import { parseFeedText } from "./parse.ts";
import { addFeed } from "./add.ts";
import { logger } from "../util/log.ts";

const log = logger("wechat");
const PAGE = 30; // we-mp-rss caps list pages at its rss.page_size (30 by default)

export interface BridgeAccount {
  id: string;
  title: string;
}

/** Every account subscribed in the we-mp-rss instance at `base`. */
export async function listBridgeAccounts(app: App, base: string): Promise<BridgeAccount[]> {
  const accounts = new Map<string, BridgeAccount>();
  for (let offset = 0; offset < 100 * PAGE; offset += PAGE) {
    const { text, url } = await fetchText(`${base}/rss/fresh?limit=${PAGE}&offset=${offset}`, { userAgent: app.cfg.feedUserAgent, timeoutMs: 20_000 });
    const { items } = parseFeedText(text, url);
    let fresh = 0;
    for (const it of items) {
      const id = (it.url || it.guid || "").match(/\/rss\/([^/?#]+)\/?$/)?.[1];
      if (!id || accounts.has(id)) continue;
      accounts.set(id, { id: decodeURIComponent(id), title: it.title || id });
      fresh++;
    }
    if (items.length < PAGE || !fresh) break;
  }
  return [...accounts.values()];
}

export function bridgeFeedUrl(base: string, accountId: string): string {
  return `${base}/feed/${encodeURIComponent(accountId)}.xml`;
}

/** Subscribe to every we-mp-rss account that Acorn does not follow yet. */
export async function syncWechatBridge(app: App): Promise<WechatBridgeSync> {
  const { url: base, folder, autoArchive } = app.settings.all().wechatBridge;
  if (!base) throw new Error("还没有填写 we-mp-rss 的地址（设置 → 微信公众号）");
  const accounts = await listBridgeAccounts(app, base);
  const result: WechatBridgeSync = { total: accounts.length, added: [], failed: [] };
  for (const acc of accounts) {
    const url = bridgeFeedUrl(base, acc.id);
    if (app.feeds.find("feed", url)) continue;
    try {
      const r = await addFeed(app, { input: url, kind: "feed", folderName: folder, autoArchive });
      if (!r.existed) result.added.push({ feedId: r.feed.id, title: r.feed.title });
    } catch (err) {
      result.failed.push({ title: acc.title, error: (err as Error).message });
    }
  }
  if (result.added.length) log.info(`subscribed ${result.added.length} WeChat account(s): ${result.added.map((a) => a.title).join("、")}`);
  return result;
}
