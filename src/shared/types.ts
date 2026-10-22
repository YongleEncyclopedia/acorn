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
  plugin?: { id: string; params?: Record<string, string> };
  headers?: Record<string, string>;
  cookie?: string;
  userAgent?: string;
  /** Feed-specific content selector used when extracting full text. */
  contentSelector?: string;
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
  method: "fetch" | "browser" | "feed" | "import";
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

export interface WechatBridgeStatus {
  url: string;
  accounts: { id: string; title: string; feedId: number | null }[];
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
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  params: { key: string; label: string; required?: boolean; placeholder?: string }[];
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
  /** When the input was a web page, the feeds discovered on it. */
  candidates: { url: string; title: string; kind: FeedKind; guessed?: boolean }[];
  /** Auto-detected HTML list rule when the page has no feed. */
  suggestedRule: HtmlRule | null;
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
