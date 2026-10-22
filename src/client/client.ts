/**
 * Typed HTTP client for a running Acorn server. Used by the CLI and the MCP server so that agents go through
 * exactly the same code paths as the web app. Auth: ACORN_TOKEN, or the token the server writes to data/.cli-token.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../server/config.ts";
import type {
  ArchiveDetail,
  ArchiveSummary,
  Counts,
  Entry,
  EntrySummary,
  EntryView,
  Feed,
  FeedConfig,
  FeedKind,
  FeedPreview,
  Highlight,
  HighlightColor,
  Page,
  PendingVerification,
  SearchResults,
  Settings,
  WechatBridgeStatus,
  WechatBridgeSync,
} from "../shared/types.ts";

export class AcornError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function defaultBaseUrl(): string {
  return (process.env.ACORN_URL || `http://127.0.0.1:${process.env.ACORN_PORT || 7700}`).replace(/\/+$/, "");
}

export function defaultToken(): string {
  if (process.env.ACORN_TOKEN) return process.env.ACORN_TOKEN;
  const dataDir = path.resolve(ROOT, process.env.ACORN_DATA_DIR || "data");
  const file = path.join(dataDir, ".cli-token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export function createClient(baseUrl = defaultBaseUrl(), token = defaultToken()) {
  async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(baseUrl + p, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AcornError(0, `连不上松果服务（${baseUrl}）。先在项目目录运行 npm start。`);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* plain text */
    }
    if (!res.ok) {
      const d = (typeof data === "object" && data ? data : { message: text }) as Record<string, unknown>;
      throw new AcornError(res.status, String(d.message || `HTTP ${res.status}`), d);
    }
    return data as T;
  }
  const qs = (o: Record<string, unknown>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
    const s = u.toString();
    return s ? `?${s}` : "";
  };
  return {
    baseUrl,
    counts: () => call<Counts>("GET", "/api/counts"),
    stats: () => call<Record<string, unknown>>("GET", "/api/stats"),
    feeds: () => call<Feed[]>("GET", "/api/feeds"),
    folders: async () => (await call<{ folders: { id: number; name: string }[] }>("GET", "/api/bootstrap")).folders,
    preview: (input: string, kind?: FeedKind, config?: FeedConfig) => call<FeedPreview>("POST", "/api/feeds/preview", { input, kind, config }),
    addFeed: (body: { input: string; kind?: FeedKind; title?: string; folderName?: string; config?: FeedConfig; fullText?: "never" | "auto" | "always"; autoArchive?: boolean }) =>
      call<{ feed: Feed; existed: boolean; added: number; error: string | null }>("POST", "/api/feeds", body),
    updateFeed: (id: number, body: Record<string, unknown>) => call<Feed>("PATCH", `/api/feeds/${id}`, body),
    deleteFeed: (id: number) => call<{ ok: boolean }>("DELETE", `/api/feeds/${id}`),
    refreshFeed: (id: number) => call<{ added: number; error?: string }>("POST", `/api/feeds/${id}/refresh?wait=1`),
    refreshAll: () => call<{ queued: number }>("POST", "/api/feeds/refresh"),
    wechatBridge: () => call<WechatBridgeStatus>("GET", "/api/wechat-bridge"),
    loginLink: () => call<{ path: string; expiresAt: number; origins: { label: string; origin: string }[] }>("POST", "/api/login-link"),
    wechatSync: () => call<WechatBridgeSync>("POST", "/api/wechat-bridge/sync"),
    entries: (q: { view?: EntryView; feed?: number; folder?: number; unread?: boolean; limit?: number; cursor?: string; q?: string }) =>
      call<Page<EntrySummary>>("GET", `/api/entries${qs(q)}`),
    entry: (id: number) => call<Entry>("GET", `/api/entries/${id}`),
    patchEntry: (id: number, body: { read?: boolean; starred?: boolean; progress?: number }) => call<EntrySummary>("PATCH", `/api/entries/${id}`, body),
    fulltext: (id: number) => call<{ ok: boolean; error?: string; entry: Entry }>("POST", `/api/entries/${id}/fulltext`),
    mark: (body: { ids?: number[]; read?: boolean; feedId?: number; view?: EntryView }) => call<{ changed: number }>("POST", "/api/entries/mark", body),
    search: (q: string) => call<SearchResults>("GET", `/api/search${qs({ q })}`),
    capture: (body: { url?: string; entryId?: number; method?: "fetch" | "browser"; tags?: string[]; title?: string }) =>
      call<{ archiveId: number; created: boolean; unchanged: boolean; warnings: string[]; title: string; gone: string | null }>("POST", "/api/archives", { ...body, wait: true }),
    pendingVerify: () => call<PendingVerification[]>("GET", "/api/archives/pending"),
    resumeCapture: (spaceId: number) => call<{ archiveId: number; title: string; warnings: string[] }>("POST", "/api/archives/resume", { spaceId }),
    captureOpenTab: (spaceId: number, url?: string) => call<{ archiveId: number; title: string; warnings: string[] }>("POST", "/api/archives/from-browser", { spaceId, url }),
    archives: (q: { q?: string; status?: string; tag?: string; limit?: number; cursor?: string }) => call<Page<ArchiveSummary>>("GET", `/api/archives${qs(q)}`),
    archive: (id: number) => call<ArchiveDetail>("GET", `/api/archives/${id}`),
    recheck: (id: number) => call<{ status: string; reason?: string }>("POST", `/api/archives/${id}/recheck`),
    patchArchive: (id: number, body: { title?: string; tags?: string[]; note?: string | null }) => call<ArchiveDetail>("PATCH", `/api/archives/${id}`, body),
    highlights: (q?: string, limit = 50) => call<Page<Highlight>>("GET", `/api/highlights${qs({ q, limit })}`),
    addHighlight: (body: { entryId?: number; archiveId?: number; quote: string; note?: string; color?: HighlightColor }) =>
      call<Highlight>("POST", "/api/highlights", { prefix: "", suffix: "", ...body }),
    settings: () => call<Settings>("GET", "/api/settings"),
    patchSettings: (body: Partial<Settings>) => call<Settings>("PATCH", "/api/settings", body),
    digestPreview: () => call<{ html: string; configured: boolean }>("GET", "/api/digest/preview"),
    digestSend: () => call<{ ok: boolean }>("POST", "/api/digest/send"),
    exportOpml: () => call<string>("GET", "/api/opml"),
    importOpml: async (xml: string) => {
      const res = await fetch(`${baseUrl}/api/opml`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/xml" }, body: xml });
      if (!res.ok) throw new AcornError(res.status, await res.text());
      return (await res.json()) as { added: number; skipped: number; folders: number };
    },
  };
}

export type AcornClient = ReturnType<typeof createClient>;

/** Turn proxied image URLs (/api/img?u=…) back into original URLs, for text meant to leave Acorn. */
export function unproxify(html: string): string {
  return html.replace(/\/api\/img\?u=([^"&\s]+)(?:&amp;r=[^"\s]*|&r=[^"\s]*)?/g, (_m, u) => {
    try {
      return decodeURIComponent(u);
    } catch {
      return u;
    }
  });
}
