import path from "node:path";
import { mkdirSync } from "node:fs";

/** Project root (the folder that contains package.json). */
export const ROOT = path.resolve(import.meta.dirname, "../..");
export const VERSION = "0.1.0";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  archiveDir: string;
  cacheDir: string;
  iconsDir: string;
  webDir: string;
  pluginsDir: string;
  rsshubBase: string;
  rsshubKey: string;
  publicUrl: string;
  initialPassword: string;
  telegramToken: string;
  telegramChatId: string;
  feedUserAgent: string;
  pageUserAgent: string;
  egoBrowserBin: string;
  /** Disable background scheduler (tests, one-off CLI runs). */
  scheduler: boolean;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(ROOT, env.ACORN_DATA_DIR || "data");
  const port = Number(env.ACORN_PORT || 7700);
  const cfg: Config = {
    host: env.ACORN_HOST || "0.0.0.0",
    port,
    dataDir,
    dbPath: path.join(dataDir, "acorn.db"),
    archiveDir: path.join(dataDir, "archive"),
    cacheDir: path.join(dataDir, "cache"),
    iconsDir: path.join(dataDir, "icons"),
    webDir: path.resolve(ROOT, env.ACORN_WEB_DIR || "dist/web"),
    pluginsDir: path.resolve(ROOT, env.ACORN_PLUGINS_DIR || "plugins"),
    rsshubBase: (env.RSSHUB_BASE || "https://rsshub.app").replace(/\/+$/, ""),
    rsshubKey: env.RSSHUB_ACCESS_KEY || "",
    publicUrl: (env.ACORN_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
    initialPassword: env.ACORN_PASSWORD || "",
    telegramToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    feedUserAgent: env.ACORN_FEED_UA || `Mozilla/5.0 (compatible; Acorn/0.1; personal feed reader)`,
    pageUserAgent: env.ACORN_PAGE_UA || BROWSER_UA,
    egoBrowserBin: env.ACORN_EGO_BROWSER || "ego-browser",
    scheduler: env.ACORN_SCHEDULER !== "off",
    ...overrides,
  };
  for (const dir of [cfg.dataDir, cfg.archiveDir, cfg.cacheDir, cfg.iconsDir, path.join(cfg.cacheDir, "img")]) {
    mkdirSync(dir, { recursive: true });
  }
  return cfg;
}
