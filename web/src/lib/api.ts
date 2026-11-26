import type {
  NetworkStatus,
  Account,
  AccountService,
  ClassCalendar,
  BrowserLogin,
  ArchiveDetail,
  ArchiveSummary,
  Bootstrap,
  Counts,
  Entry,
  EntrySummary,
  EntryView,
  Feed,
  FeedConfig,
  FeedKind,
  FeedPreview,
  FetchLogItem,
  Folder,
  FullTextMode,
  Highlight,
  OfflineAssets,
  HighlightColor,
  ImportBatch,
  ImportItem,
  ImportPreview,
  Page,
  PendingVerification,
  SearchResults,
  Settings,
  Stats,
  TranslationJob,
  ArticleSummary,
  BackupReport,
  BackupStatus,
  WechatBridgeStatus,
  WechatBridgeSync,
  ModelList,
  ModelTest,
  TranslateSettings,
} from "../../../src/shared/types.ts";
import { noteAnswer } from "./connection.ts";

/** The AI settings the settings page is editing, sent before they are saved. */
export type AiDraft = Pick<TranslateSettings, "provider" | "preset" | "baseUrl" | "apiKey"> & Partial<Pick<TranslateSettings, "model" | "reasoning" | "contextLength" | "extraBody">>;

export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;
  constructor(status: number, code: string, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    noteAnswer(true);
    throw new ApiError(0, "offline", "连不上松果服务，请检查网络", {});
  }
  noteAnswer(res.headers.has("x-acorn-cached"));
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const d = (typeof data === "object" ? data : { message: data }) as Record<string, unknown>;
    if (res.status === 401) window.dispatchEvent(new CustomEvent("acorn:unauthorized"));
    throw new ApiError(res.status, String(d.error || res.status), String(d.message || `请求失败（${res.status}）`), d);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);
const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export interface EntryQuery {
  view?: EntryView;
  feed?: number;
  folder?: number;
  unread?: boolean;
  order?: "new" | "old";
  q?: string;
}

type ListTarget = { view: EntryView } | { feed: number } | { folder: number };

/** 未读 is a filter already, and 稍后读, 在读 and 已入藏 are kept regardless of read state: the others can hide what is read. */
export const canFilterUnread = (t: ListTarget): boolean => !("view" in t) || t.view === "today" || t.view === "all";

/** The query a list is fetched with. The offline pack builds the same one, so what it stores is what the list asks for. */
export function listQuery(t: ListTarget, how: { unreadOnly: boolean; order: "new" | "old" }): EntryQuery {
  return { ...t, unread: (canFilterUnread(t) && how.unreadOnly) || undefined, order: how.order === "old" ? "old" : undefined };
}

/** The address of a page of a list (the offline pack walks a list through the same addresses). */
export const entriesPath = (q: EntryQuery, cursor?: string | null): string => `/api/entries${qs({ ...q, cursor, limit: 40 })}`;

/** A picture through the server's image proxy, the way the server writes it into articles (src/server/api/content.ts). */
export const imageProxy = (url: string, referer?: string | null): string => `/api/img?u=${encodeURIComponent(url)}${referer ? `&r=${encodeURIComponent(referer)}` : ""}`;

export interface AddFeedBody {
  input: string;
  kind?: FeedKind;
  title?: string;
  folderId?: number | null;
  folderName?: string;
  config?: FeedConfig;
  fullText?: FullTextMode;
  autoArchive?: boolean;
  fetchInterval?: number | null;
}

export const api = {
  session: () => get<{ authenticated: boolean; setupRequired: boolean; canSetup: boolean }>("/api/session"),
  login: (password: string) => post<{ ok: boolean }>("/api/login", { password }),
  setup: (password: string) => post<{ ok: boolean }>("/api/setup", { password }),
  logout: () => post<{ ok: boolean }>("/api/logout"),
  bootstrap: () => get<Bootstrap>("/api/bootstrap"),
  counts: () => get<Counts>("/api/counts"),

  entries: (q: EntryQuery, cursor?: string | null) => get<Page<EntrySummary>>(entriesPath(q, cursor)),
  entry: (id: number) => get<Entry>(`/api/entries/${id}`),
  patchEntry: (id: number, body: { read?: boolean; starred?: boolean; progress?: number }) => patch<EntrySummary>(`/api/entries/${id}`, body),
  fulltext: (id: number) => post<{ ok: boolean; error?: string; entry: Entry }>(`/api/entries/${id}/fulltext`),
  mark: (body: { ids?: number[]; read?: boolean; view?: EntryView; feedId?: number; folderId?: number; before?: number; upTo?: number; newerThan?: number }) =>
    post<{ changed: number; counts: Counts }>("/api/entries/mark", body),

  preview: (input: string, kind?: FeedKind, config?: FeedConfig) => post<FeedPreview>("/api/feeds/preview", { input, kind, config }),
  addFeed: (body: AddFeedBody) => post<{ feed: Feed; existed: boolean; added: number; error: string | null }>("/api/feeds", body),
  patchFeed: (id: number, body: Partial<{ customTitle: string | null; folderId: number | null; config: FeedConfig; fullText: FullTextMode; autoArchive: boolean; fetchInterval: number | null; paused: boolean; url: string }>) =>
    patch<Feed>(`/api/feeds/${id}`, body),
  deleteFeed: (id: number) => del<{ ok: boolean }>(`/api/feeds/${id}`),
  refreshFeed: (id: number, wait = false) => post<{ queued?: boolean; added?: number; error?: string }>(`/api/feeds/${id}/refresh${wait ? "?wait=1" : ""}`),
  refreshAll: () => post<{ queued: number }>("/api/feeds/refresh"),
  translate: (texts: string[], lang?: string, fresh?: boolean) => post<TranslationJob>("/api/translate", { texts, lang, fresh }),
  translation: (id: string) => get<TranslationJob>(`/api/translate/${id}`),
  translationKnown: (texts: string[], lang?: string) => post<{ total: number; cached: number }>("/api/translate/known", { texts, lang }),
  summary: (body: { entryId?: number; archiveId?: number; generate?: boolean; fresh?: boolean }) => post<{ summary: ArticleSummary | null }>("/api/summary", body),
  addresses: () => get<{ origins: { label: string; origin: string }[] }>("/api/addresses"),
  loginLink: () => post<{ path: string; expiresAt: number; origins: { label: string; origin: string }[] }>("/api/login-link"),
  /** The models of a service as typed into the settings page, before saving. */
  aiModels: (draft: AiDraft) => post<ModelList>("/api/translate/models", draft),
  /** One sentence through a configuration: the saved one, or the draft. */
  translateTest: (draft?: AiDraft) => post<ModelTest>("/api/translate/test", draft),
  wechatBridge: () => get<WechatBridgeStatus>("/api/wechat-bridge"),
  wechatSync: () => post<WechatBridgeSync>("/api/wechat-bridge/sync"),
  feedLogs: (id: number) => get<FetchLogItem[]>(`/api/feeds/${id}/logs`),
  createFolder: (name: string) => post<Folder>("/api/folders", { name }),
  patchFolder: (id: number, body: { name?: string; sort?: number }) => patch<{ ok: boolean }>(`/api/folders/${id}`, body),
  deleteFolder: (id: number) => del<{ ok: boolean }>(`/api/folders/${id}`),
  importOpml: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ added: number; skipped: number; folders: number }>("POST", "/api/opml", fd);
  },

  archives: (p: { q?: string; tag?: string; status?: string }, cursor?: string | null) => get<Page<ArchiveSummary>>(`/api/archives${qs({ ...p, cursor, limit: 36 })}`),
  archiveTags: () => get<{ tag: string; count: number }[]>("/api/archives/tags"),
  archive: (id: number, snapshot?: number) => get<ArchiveDetail>(`/api/archives/${id}${qs({ snapshot })}`),
  capture: (body: { url?: string; entryId?: number; method?: "fetch" | "browser"; tags?: string[]; wait?: boolean }) =>
    post<{ queued?: boolean; archiveId?: number; created?: boolean; unchanged?: boolean; warnings?: string[]; title?: string }>("/api/archives", body),
  pendingVerify: () => get<PendingVerification[]>("/api/archives/pending"),
  resumeCapture: (spaceId: number) => post<{ archiveId: number; title: string; warnings: string[] }>("/api/archives/resume", { spaceId }),
  dropPending: (spaceId: number) => del<{ ok: boolean }>(`/api/archives/pending/${spaceId}`),
  snapshot: (id: number, method: "fetch" | "browser") => post<{ queued: boolean }>(`/api/archives/${id}/snapshot`, { method }),
  recheck: (id: number) => post<{ status: string; reason?: string }>(`/api/archives/${id}/recheck`),
  patchArchive: (id: number, body: { title?: string; tags?: string[]; note?: string | null }) => patch<ArchiveDetail>(`/api/archives/${id}`, body),
  deleteArchive: (id: number) => del<{ ok: boolean }>(`/api/archives/${id}`),
  importArchive: (fd: FormData) => request<{ archiveId: number; title: string }>("POST", "/api/archives/import", fd),
  waybackRescue: (id: number) => post<{ archiveId: number; title: string; warnings: string[] }>(`/api/archives/${id}/wayback`),

  // moving in from other tools (搬家)
  importPreview: (fd: FormData) => request<ImportPreview>("POST", "/api/imports/preview", fd),
  startImport: (fd: FormData) => request<ImportBatch>("POST", "/api/imports", fd),
  imports: () => get<ImportBatch[]>("/api/imports"),
  importItems: (id: number, status: string) => get<ImportItem[]>(`/api/imports/${id}/items${qs({ status })}`),
  retryImport: (id: number, statuses?: string[]) => post<{ changed: number }>(`/api/imports/${id}/retry`, { statuses }),
  patchImport: (id: number, body: { paused?: boolean; tags?: string[]; wayback?: boolean }) => patch<ImportBatch>(`/api/imports/${id}`, body),
  deleteImport: (id: number) => del<{ ok: boolean }>(`/api/imports/${id}`),

  backupStatus: () => get<BackupStatus>("/api/backup"),
  runBackup: (dir?: string, wait = false) => post<BackupStatus | BackupReport>("/api/backup", { dir, wait }),

  highlights: (q?: string, cursor?: string | null) => get<Page<Highlight>>(`/api/highlights${qs({ q, cursor, limit: 60 })}`),
  createHighlight: (body: { entryId?: number | null; archiveId?: number | null; quote: string; prefix: string; suffix: string; note?: string | null; color?: HighlightColor }) =>
    post<Highlight>("/api/highlights", body),
  patchHighlight: (id: number, body: { note?: string | null; color?: HighlightColor }) => patch<Highlight>(`/api/highlights/${id}`, body),
  deleteHighlight: (id: number) => del<{ ok: boolean }>(`/api/highlights/${id}`),

  search: (q: string) => get<SearchResults>(`/api/search${qs({ q })}`),
  settings: () => get<Settings>("/api/settings"),
  patchSettings: (body: Partial<Settings>) => patch<Settings>("/api/settings", body),
  password: (current: string, next: string) => post<{ ok: boolean }>("/api/password", { current, next }),
  tokens: () => get<{ id: number; name: string; createdAt: number; lastUsedAt: number | null }[]>("/api/tokens"),
  createToken: (name: string) => post<{ token: string }>("/api/tokens", { name }),
  deleteToken: (id: number) => del<{ ok: boolean }>(`/api/tokens/${id}`),
  stats: () => get<Stats & { jobs: { queued: number; running: number } }>("/api/stats"),
  logs: () => get<{ at: number; level: string; scope: string; msg: string }[]>("/api/logs"),
  digestPreview: () => get<{ html: string; configured: boolean }>("/api/digest/preview"),
  digestSend: () => post<{ ok: boolean }>("/api/digest/send"),
  offlineAssets: () => get<OfflineAssets>("/api/offline/assets"),

  // 账号: sign-ins to platforms such as 知识星球 and Canvas (the server keeps the credential)
  accounts: () => get<{ services: AccountService[]; accounts: Account[] }>("/api/accounts"),
  connectAccount: (body: { service: string; origin?: string; token?: string; cookie?: string }) => post<{ account: Account }>("/api/accounts", body),
  browserLogin: (body: { service: string; origin?: string }) => post<BrowserLogin>("/api/accounts/browser", body),
  browserLoginDone: (spaceId: number) => post<BrowserLogin>(`/api/accounts/browser/${spaceId}`),
  checkAccount: (id: number) => post<{ account: Account }>(`/api/accounts/${id}/check`),
  deleteAccount: (id: number) => del<{ ok: boolean }>(`/api/accounts/${id}`),
  // 班级日历
  classCalendar: () => get<ClassCalendar>("/api/class-calendar"),
  addClassLinks: (text: string) => post<{ added: number; failed: { name: string; error: string }[]; calendar: ClassCalendar }>("/api/class-calendar/members", { text }),
  addOwnCanvas: () => post<ClassCalendar>("/api/class-calendar/own-canvas"),
  removeClassMember: (id: number) => del<ClassCalendar>(`/api/class-calendar/members/${id}`),
  patchClassCalendar: (body: { minCount?: number; include?: "important" | "all"; feishuAppId?: string; feishuAppSecret?: string; feishuCalendarId?: string }) => patch<ClassCalendar>("/api/class-calendar", body),
  syncClassCalendar: () => post<{ feishu: { created: number; updated: number; removed: number } | null; calendar: ClassCalendar }>("/api/class-calendar/sync"),
  classCalendarLink: () => post<{ path: string }>("/api/class-calendar/link"),
  // 网络: the proxy, and whether a site can be reached
  network: () => get<NetworkStatus>("/api/network"),
  networkTest: (url?: string) => post<{ ok: boolean; status?: number; error?: string; ms: number; via: string; url: string }>("/api/network/test", url ? { url } : {}),
  // the key of the RSS addresses (/out/*)
  outputKey: () => get<{ key: string }>("/api/outputs/key"),
  newOutputKey: () => post<{ key: string }>("/api/outputs/key"),
  pluginChoices: (id: string, key: string, account?: number | null) => get<{ value: string; label: string }[]>(`/api/plugins/${encodeURIComponent(id)}/choices${qs({ key, account })}`),
};
