/**
 * Plugin API for custom sources. A plugin is a TypeScript file in /plugins that default-exports an AcornPlugin.
 * Plugins are hot-reloaded when the file changes. See docs/plugins.md and plugins/example-*.ts.
 */
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

export interface PluginContext {
  params: Record<string, string>;
  fetchText: (url: string, opts?: { headers?: Record<string, string>; referer?: string; cookie?: string }) => Promise<string>;
  fetchJson: <T = unknown>(url: string, opts?: { headers?: Record<string, string>; referer?: string; cookie?: string }) => Promise<T>;
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
  params?: { key: string; label: string; required?: boolean; placeholder?: string }[];
  fetch: (ctx: PluginContext) => Promise<PluginResult>;
}
