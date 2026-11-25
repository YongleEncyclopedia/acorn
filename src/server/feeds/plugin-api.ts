/**
 * Plugin API for custom sources. A plugin is a TypeScript file in /plugins that default-exports an AcornPlugin;
 * the platforms Acorn signs in to (知识星球, Canvas…) come built in (src/server/feeds/builtin). Plugins are
 * hot-reloaded when the file changes. See docs/plugins.md and plugins/*.ts.
 */
import type { PluginParam } from "../../shared/types.ts";

export interface PluginItem {
  title: string;
  url?: string | null;
  /** Stable id; defaults to url, then title. */
  guid?: string;
  /** HTML content (will be sanitized). */
  content?: string | null;
  summary?: string | null;
  author?: string | null;
  image?: string | null;
  /** Epoch ms, ISO string, or loose Chinese date text like "2026年10月13日". */
  publishedAt?: number | string | Date | null;
}

export interface PluginResult {
  title?: string;
  siteUrl?: string;
  description?: string;
  items: PluginItem[];
}

interface RequestOptions {
  headers?: Record<string, string>;
  referer?: string;
  cookie?: string;
  accept?: string;
}

/** The account a plugin reads with (设置 → 账号): where the platform is, and how to sign a request in. */
export interface PluginAccount {
  id: number;
  origin: string;
  /** Who is signed in. */
  name: string;
  token?: string;
  cookie?: string;
  /** Cookies by host, for sign-ins that span hosts (a portal and its single sign-on). Renewing one updates it in place. */
  jar?: Record<string, Record<string, string>>;
}

/** What a source keeps between fetches, per subscription (JSON values). In a preview it lasts for that one run. */
export interface PluginState {
  get: <T = unknown>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
}

export interface PluginContext {
  params: Record<string, string>;
  /** Kept from one fetch of this subscription to the next. */
  state: PluginState;
  fetchText: (url: string, opts?: RequestOptions) => Promise<string>;
  fetchJson: <T = unknown>(url: string, opts?: RequestOptions) => Promise<T>;
  /** Any GET request. Does not throw on error statuses, and gives the headers (pagination links, a refused sign-in…). */
  request: (url: string, opts?: RequestOptions) => Promise<{ status: number; ok: boolean; url: string; headers: Headers; text: string }>;
  /** The signed-in account, for plugins that declare `account`; null otherwise. */
  account: PluginAccount | null;
  /** The sign-in stopped working: the subscription asks for a new one (设置 → 账号) instead of retrying. */
  loginExpired: (message?: string) => never;
  /** linkedom parser: returns a DOM Window with document/querySelector support. */
  parseHTML: (html: string) => { document: Document };
  absolutize: (href: string | null | undefined, base: string) => string | null;
  parseDate: (input: unknown) => number | null;
  log: (msg: string) => void;
}

export interface AcornPlugin {
  id: string;
  name: string;
  description?: string;
  params?: PluginParam[];
  /** The platform it signs in to (an id from src/server/accounts/services.ts, e.g. "zsxq"): it gets `ctx.account`. */
  account?: string;
  /** The choices of a `fromAccount` parameter (the 星球 the account joined…). */
  choices?: (ctx: PluginContext, key: string) => Promise<{ value: string; label: string }[]>;
  /** Built-in only: where 添加订阅 lists it (default: with the sources that need an account when it has `account`). */
  group?: "account" | "general" | "hidden";
  fetch: (ctx: PluginContext) => Promise<PluginResult>;
}

/** Thrown by ctx.loginExpired(): the platform no longer accepts the account's sign-in. */
export class LoginExpiredError extends Error {
  constructor(message = "登录已过期") {
    super(message);
    this.name = "LoginExpiredError";
  }
}
