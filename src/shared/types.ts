/**
 * Types shared by the server API and the web app. All timestamps are epoch milliseconds.
 * Keep this file dependency-free: it is imported from both Node and the browser bundle.
 */

export type FeedKind = "feed" | "rsshub" | "html" | "plugin";
export type FullTextMode = "never" | "auto" | "always";
export type SourceStatus = "alive" | "changed" | "gone" | "unknown";
export type HighlightColor = "amber" | "green" | "blue" | "rose" | "violet";

export interface Folder {
  id: number;
  name: string;
  sort: number;
}

/** Selector rule for turning an HTML list page into a feed (school notices, department news...). */
export interface HtmlRule {
  /** CSS selector matching each item in the list. */
  item: string;
  /** Selector for the title inside an item (defaults to the first link). */
  title?: string;
  /** Selector for the link; append @attr to read an attribute (defaults to a@href). */
  link?: string;
  /** Selector for the date text (optional; dates like 2026-10-13, 10-13, 3小时前 are understood). */
  date?: string;
  /** Selector for a summary (optional). */
  summary?: string;
  /** Selector for an image (optional, e.g. img@src). */
  image?: string;
}

export interface FeedConfig {
  html?: HtmlRule;
  /** `account`: the 账号 (Settings → 账号) a plugin signs in with, for platforms that need one. */
  plugin?: { id: string; params?: Record<string, string>; account?: number };
  headers?: Record<string, string>;
  cookie?: string;
  userAgent?: string;
  /** Feed-specific content selector used when extracting full text. */
  contentSelector?: string;
  /**
   * Read through the user's own browser (ego-browser) instead of the server: for sites whose bot protection stops
   * servers, and for pages whose list is filled in by scripts (the rendered page is read).
   */
  browser?: boolean;
}

export interface Feed {
  id: number;
  kind: FeedKind;
  url: string;
  title: string;
  originalTitle: string;
  customTitle: string | null;
  siteUrl: string | null;
  description: string | null;
  hasIcon: boolean;
  folderId: number | null;
  config: FeedConfig;
  fullText: FullTextMode;
  autoArchive: boolean;
  fetchInterval: number | null;
  paused: boolean;
  lastFetchedAt: number | null;
  lastSuccessAt: number | null;
  nextFetchAt: number;
  errorCount: number;
  lastError: string | null;
  unread: number;
  total: number;
  createdAt: number;
}

export interface EntrySummary {
  id: number;
  feedId: number;
  title: string;
  url: string | null;
  author: string | null;
  summary: string | null;
  image: string | null;
  publishedAt: number | null;
  createdAt: number;
  readAt: number | null;
  starredAt: number | null;
  progress: number;
  wordCount: number;
  archiveId: number | null;
  highlightCount: number;
}

export interface Entry extends EntrySummary {
  /** Best available HTML (full text if extracted, otherwise feed content), sanitized. */
  content: string;
  feedContent: string;
  hasFullContent: boolean;
  fullFetchedAt: number | null;
  fullError: string | null;
  highlights: Highlight[];
  archive: ArchiveSummary | null;
}

export interface Highlight {
  id: number;
  entryId: number | null;
  archiveId: number | null;
  quote: string;
  prefix: string;
  suffix: string;
  note: string | null;
  color: HighlightColor;
  createdAt: number;
  updatedAt: number;
  /** Populated in list views. */
  title?: string;
  url?: string | null;
  source?: string | null;
}

export interface ArchiveSummary {
  id: number;
  url: string;
  entryId: number | null;
  title: string;
  site: string | null;
  author: string | null;
  publishedAt: number | null;
  excerpt: string | null;
  leadImage: string | null;
  tags: string[];
  sourceStatus: SourceStatus;
  sourceCheckedAt: number | null;
  goneAt: number | null;
  createdAt: number;
  updatedAt: number;
  snapshotCount: number;
  latestCapturedAt: number | null;
  bytes: number;
  highlightCount: number;
}

export interface SnapshotFiles {
  article: string;
  markdown: string;
  source: string | null;
  mhtml: string | null;
  screenshot: string | null;
  folder: string;
}

export interface Snapshot {
  id: number;
  archiveId: number;
  capturedAt: number;
  method: "fetch" | "browser" | "feed" | "import" | "wayback";
  bytes: number;
  assets: number;
  textLength: number;
  status: string;
  warnings: string[];
  files: SnapshotFiles;
}

export interface ArchiveDetail extends ArchiveSummary {
  content: string;
  note: string | null;
  snapshots: Snapshot[];
  highlights: Highlight[];
  absolutePath: string;
}

/** Moving in from other tools: one uploaded export file, archived link by link in the background. */
export type ImportItemStatus = "pending" | "done" | "rescued" | "gone" | "failed" | "skipped";

export interface ImportBatch {
  id: number;
  source: string;
  label: string;
  options: { tags: string[]; wayback: boolean };
  paused: boolean;
  createdAt: number;
  finishedAt: number | null;
  total: number;
  counts: Record<ImportItemStatus, number>;
}

export interface ImportItem {
  id: number;
  url: string;
  title: string | null;
  status: ImportItemStatus;
  archiveId: number | null;
  error: string | null;
  savedAt: number | null;
}

export interface ImportPreview {
  format: string;
  label: string;
  /** Links that will be archived. */
  total: number;
  /** Of those, already in the archive (their tags are merged instead). */
  already: number;
  /** Left out: duplicates, bookmarklets and other non-web addresses. */
  skipped: number;
  tags: { tag: string; count: number }[];
  sample: { url: string; title: string | null; tags: string[]; savedAt: number | null }[];
}

export interface Counts {
  unread: number;
  today: number;
  starred: number;
  archived: number;
  inProgress: number;
  highlights: number;
  gone: number;
  feeds: number;
  failing: number;
}

export interface ReaderPrefs {
  theme: "auto" | "paper" | "sepia" | "night" | "ink";
  font: "serif" | "kai" | "sans";
  fontSize: number;
  lineHeight: number;
  width: "narrow" | "medium" | "wide";
  indent: boolean;
  justify: boolean;
}

export interface Settings {
  defaultInterval: number;
  archiveOnStar: boolean;
  archiveOnHighlight: boolean;
  markReadOnOpen: boolean;
  retentionDays: number;
  rsshubBase: string;
  rsshubKey: string;
  recheckDays: number;
  digest: { enabled: boolean; cron: string; folders: number[]; limit: number };
  reader: ReaderPrefs;
  /** we-mp-rss instance whose WeChat accounts are mirrored as feeds; empty url = off. */
  wechatBridge: { url: string; folder: string; autoArchive: boolean };
  translate: TranslateSettings;
  /** A second data directory kept up to date: empty dir = off; cron = when the daily copy runs. */
  backup: { dir: string; auto: boolean; cron: string };
  /** How the server reaches the internet. */
  network: NetworkSettings;
}

/** system: the proxy this computer uses (environment, or macOS network settings); manual: `url`; off: direct. */
export interface NetworkSettings {
  proxy: "system" | "manual" | "off";
  url: string;
  /** Hosts that never go through the proxy, comma separated (local services, the campus network). */
  bypass: string;
}

/** What the server does about the proxy right now. */
export interface NetworkStatus {
  /** The proxy in use ("" = direct). */
  active: string;
  /** The proxy this computer is set to use, if any. */
  system: string;
  /** This Node can use a proxy at all (Node 24+). */
  supported: boolean;
}

export interface BackupReport {
  at: number;
  ok: boolean;
  error: string | null;
  dir: string;
  /** Snapshot folders in the library, and how many of them were new to the backup. */
  snapshots: number;
  copied: number;
  bytes: number;
  ms: number;
}

export interface BackupStatus {
  running: boolean;
  progress: { copied: number; total: number } | null;
  last: BackupReport | null;
}

export type TranslateProvider = "ollama" | "openai" | "anthropic";

export interface TranslateSettings {
  /** ollama = local models; openai = any OpenAI-compatible API (DeepSeek, Qwen, OpenRouter…); anthropic = Claude. */
  provider: TranslateProvider;
  /** API root; empty = the provider's default. */
  baseUrl: string;
  model: string;
  /** Sent to clients masked; patching with the masked value keeps the stored key. */
  apiKey: string;
  targetLang: string;
  /** Translate foreign-language articles as soon as they are opened. */
  auto: boolean;
  /** Show translated titles under foreign-language titles in article lists. */
  titles: boolean;
  display: "bilingual" | "only";
}

/** Key points of an article, written by the translation model. */
export interface ArticleSummary {
  points: string[];
  model: string;
  cached: boolean;
}

/** A translation request: texts in, translations out (null = not translated yet). */
export interface TranslationJob {
  id: string;
  lang: string;
  total: number;
  done: number;
  items: (string | null)[];
  error: string | null;
  model: string;
}

/** The web app's files, for the offline pack (离线包): what a device stores so the reader opens without a connection. */
export interface OfflineAssets {
  /** The page, its code and styles, the manifest and icon. */
  app: string[];
  /** The reading fonts, by the setting that shows them (黑体 is the system's own). */
  fonts: { serif: string[]; kai: string[] };
  bytes: { app: number; serif: number; kai: number };
}

/** A platform Acorn can sign in to, to read what the user's own account sees there. */
export interface AccountService {
  id: string;
  name: string;
  /** Where it lives; services that run at many addresses (Canvas) let the user change it. */
  origin: string;
  originEditable: boolean;
  /** Signing in in the user's own browser (ego-browser) is possible: Acorn reads the sign-in from there. */
  browserLogin: boolean;
  /** Signing in by hand: what to paste, and where to find it. */
  manual: { kind: "token" | "cookie"; label: string; placeholder: string; steps: string[]; link?: string };
}

/** A sign-in to one platform. The credential itself never leaves the server. */
export interface Account {
  id: number;
  service: string;
  origin: string;
  /** Who the platform says is signed in. */
  name: string;
  /** expired: the platform no longer accepts the sign-in; subscriptions using it wait for a new one. */
  status: "ok" | "expired" | "error";
  error: string | null;
  checkedAt: number | null;
  createdAt: number;
  /** Subscriptions that read with it. */
  feeds: number;
}

/** Signing in through the user's browser: done, or waiting for the user in the page Acorn opened. */
export type BrowserLogin = { account: Account } | { waiting: true; spaceId: number; message: string };

/** 班级日历: a classmate who chose to share their Canvas calendar link. The link itself never comes back whole. */
export interface ClassMember {
  id: number;
  name: string;
  /** The link, masked: its host and the last characters, to tell links apart. */
  link: string;
  createdAt: number;
  checkedAt: number | null;
  error: string | null;
  /** Items the link held at the last fetch. */
  events: number;
  /** The owner's own source (their Canvas announcements), not a classmate's link. */
  own: boolean;
}

/** One item of the class calendar: how many classmates have it, never who. */
export interface ClassEvent {
  key: string;
  kind: "exam" | "quiz" | "lab" | "presentation" | "assignment" | "event";
  /** The course and title only when at least `minCount` classmates have it; otherwise the kind and the count. */
  title: string;
  course: string | null;
  count: number;
  /** From the owner's own Canvas (a course's announcement or due date), not only from classmates. */
  mine: boolean;
  start: number;
  end: number;
  allDay: boolean;
  /** A due date: shown as the half hour before it. */
  due: boolean;
}

export interface ClassCalendarConfig {
  /** Below this many classmates, an item shows only its kind and count. */
  minCount: number;
  /** important: exams, quizzes, labs, presentations; all: every course item, homework included. */
  include: "important" | "all";
  feishuAppId: string;
  feishuCalendarId: string;
  feishuSyncedAt: number | null;
  feishuError: string | null;
}

export interface ClassCalendar {
  config: ClassCalendarConfig & { feishuSecretSet: boolean };
  members: ClassMember[];
  /** The next weeks of the class calendar. */
  events: ClassEvent[];
}

export interface WechatBridgeStatus {
  url: string;
  accounts: { id: string; title: string; feedId: number | null }[];
  /** When the newest article from any of these accounts arrived (null = none yet). */
  lastEntryAt?: number | null;
}

export interface WechatBridgeSync {
  total: number;
  added: { feedId: number; title: string }[];
  failed: { title: string; error: string }[];
}

export interface Bootstrap {
  version: string;
  folders: Folder[];
  feeds: Feed[];
  counts: Counts;
  settings: Settings;
  plugins: PluginInfo[];
  egoBrowser: boolean;
  telegram: boolean;
  dataDir: string;
  /** Where the program itself is installed (the repository, or inside the desktop app), and the port it serves on. */
  appDir: string;
  port: number;
}

export interface PluginParam {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  /** Fixed choices, shown as a menu. */
  options?: { value: string; label: string }[];
  /** The choices come from the signed-in account (the 星球 it joined…): GET /api/plugins/:id/choices. */
  fromAccount?: boolean;
  /** Not shown in forms (filled in by Acorn). */
  hidden?: boolean;
  /** Filled with a random value when a subscription is made without it (a push address's token). */
  generate?: boolean;
  /** Left out of the subscription's address and of OPML exports (a push token). */
  secret?: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  params: PluginParam[];
  /** Comes with Acorn (src/server/feeds/builtin) rather than from the plugins directory. */
  builtin?: boolean;
  /** The platform whose 账号 it reads with (an AccountService id). */
  account?: string;
  /** Where 添加订阅 lists it: sources that need an account, general sources (JSON, page watch), or nowhere (push). */
  group?: "account" | "general" | "hidden";
  error?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface PreviewItem {
  title: string;
  url: string | null;
  publishedAt: number | null;
  summary: string | null;
  image: string | null;
}

export interface FeedPreview {
  kind: FeedKind;
  url: string;
  resolvedUrl: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  items: PreviewItem[];
  /** When the input was a web page, the feeds discovered on it. `browser`: only the user's browser can read it. */
  candidates: { url: string; title: string; kind: FeedKind; guessed?: boolean; browser?: boolean }[];
  /** Auto-detected HTML list rule when the page has no feed. */
  suggestedRule: HtmlRule | null;
  /** RSSHub routes for this address (from RSSHub's radar rules): platforms that block servers or have no feed. */
  rsshub?: RsshubMatch[];
  /** The address answers JSON: how its items map to articles (the `json` source's parameters). */
  json?: Record<string, string> | null;
  /** Why the address itself could not be read, when other ways are still offered. */
  problem?: string;
  /** Read through the user's browser: subscribing keeps reading it that way (FeedConfig.browser). */
  browser?: boolean;
}

/** An RSSHub route that serves a page, worked out from RSSHub's radar rules. */
export interface RsshubMatch {
  title: string;
  route: string;
  /** The route's documentation (what its parameters mean, whether it needs a cookie). */
  docs?: string;
}

export interface SearchResults {
  query: string;
  entries: EntrySummary[];
  archives: ArchiveSummary[];
  highlights: Highlight[];
}

export interface FetchLogItem {
  at: number;
  status: "ok" | "not_modified" | "error";
  added: number;
  ms: number;
  error: string | null;
}

export interface Stats {
  entries: number;
  archives: number;
  snapshots: number;
  archiveBytes: number;
  cacheBytes: number;
  dbBytes: number;
  highlights: number;
  feeds: number;
  oldestEntry: number | null;
}

export type ServerEvent =
  | { type: "entries"; feedId: number; added: number }
  | { type: "feed"; feedId: number; ok: boolean; error?: string | null }
  | { type: "fulltext"; entryId: number; ok: boolean }
  | { type: "archive"; archiveId: number | null; url: string; status: "queued" | "done" | "error" | "verify"; title?: string; error?: string; spaceId?: number | null }
  | { type: "counts" }
  | { type: "translation"; id: string; done: number; total: number; error?: string | null }
  | { type: "import"; id: number; finished: boolean }
  | { type: "backup"; running: boolean; copied?: number; total?: number; ok?: boolean; error?: string | null }
  | { type: "hello"; at: number };

/** A browser capture waiting for the user to pass a captcha / login in the handed-off ego-browser page. */
export interface PendingVerification {
  spaceId: number;
  url: string;
  entryId: number | null;
  tags?: string[];
  title?: string;
  reason: string;
  createdAt: number;
}

export type EntryView = "all" | "unread" | "today" | "starred" | "progress" | "archived";
