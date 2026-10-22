import type { Db } from "../db/index.ts";
import type { Settings } from "../../shared/types.ts";

export const DEFAULT_SETTINGS: Settings = {
  defaultInterval: 30,
  archiveOnStar: true,
  archiveOnHighlight: true,
  markReadOnOpen: true,
  retentionDays: 0,
  rsshubBase: "",
  rsshubKey: "",
  recheckDays: 7,
  digest: { enabled: false, cron: "0 8 * * *", folders: [], limit: 12 },
  reader: { theme: "auto", font: "serif", fontSize: 18, lineHeight: 1.85, width: "medium", indent: false, justify: true },
  wechatBridge: { url: "", folder: "公众号", autoArchive: true },
  translate: { provider: "ollama", baseUrl: "", model: "qwen3:8b", apiKey: "", targetLang: "zh-CN", auto: false, titles: false, display: "bilingual" },
  backup: { dir: "", auto: false, cron: "0 3 * * *" },
};

const MASK = "••••";
const isMaskedKey = (key: string) => key.startsWith(MASK);

/** Settings as sent to clients: secrets are masked (the last 4 characters stay so the user can tell keys apart). */
export function publicSettings(s: Settings): Settings {
  const key = s.translate.apiKey;
  return key ? { ...s, translate: { ...s.translate, apiKey: `${MASK}${key.slice(-4)}` } } : s;
}

/** Internal (non-user-facing) keys live in the same table with a leading underscore. */
export class SettingsStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  getRaw(key: string): string | undefined {
    return this.db.get<{ value: string }>("select value from settings where key = ?", key)?.value;
  }

  setRaw(key: string, value: string): void {
    this.db.run("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }

  deleteRaw(key: string): void {
    this.db.run("delete from settings where key = ?", key);
  }

  all(): Settings {
    const stored = this.getRaw("app");
    const parsed = stored ? (JSON.parse(stored) as Partial<Settings>) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      digest: { ...DEFAULT_SETTINGS.digest, ...(parsed.digest || {}) },
      reader: { ...DEFAULT_SETTINGS.reader, ...(parsed.reader || {}) },
      wechatBridge: { ...DEFAULT_SETTINGS.wechatBridge, ...(parsed.wechatBridge || {}) },
      translate: { ...DEFAULT_SETTINGS.translate, ...(parsed.translate || {}) },
      backup: { ...DEFAULT_SETTINGS.backup, ...(parsed.backup || {}) },
    };
  }

  update(patch: Partial<Settings>): Settings {
    const cur = this.all();
    const next: Settings = {
      ...cur,
      ...patch,
      digest: { ...cur.digest, ...(patch.digest || {}) },
      reader: { ...cur.reader, ...(patch.reader || {}) },
      wechatBridge: { ...cur.wechatBridge, ...(patch.wechatBridge || {}) },
      translate: { ...cur.translate, ...(patch.translate || {}) },
      backup: { ...cur.backup, ...(patch.backup || {}) },
    };
    if (patch.translate?.apiKey !== undefined && isMaskedKey(patch.translate.apiKey)) next.translate.apiKey = cur.translate.apiKey;
    next.defaultInterval = Math.max(5, Math.min(24 * 60, Math.round(next.defaultInterval)));
    next.recheckDays = Math.max(0, Math.min(365, Math.round(next.recheckDays)));
    next.retentionDays = Math.max(0, Math.round(next.retentionDays));
    next.rsshubBase = (next.rsshubBase || "").trim().replace(/\/+$/, "");
    next.wechatBridge.url = (next.wechatBridge.url || "").trim().replace(/\/+$/, "");
    next.wechatBridge.folder = (next.wechatBridge.folder || "").trim() || DEFAULT_SETTINGS.wechatBridge.folder;
    next.translate.baseUrl = (next.translate.baseUrl || "").trim().replace(/\/+$/, "");
    next.translate.model = (next.translate.model || "").trim();
    next.translate.apiKey = (next.translate.apiKey || "").trim();
    next.backup.dir = (next.backup.dir || "").trim().replace(/[\\/]+$/, "");
    next.backup.cron = (next.backup.cron || "").trim() || DEFAULT_SETTINGS.backup.cron;
    this.setRaw("app", JSON.stringify(next));
    return next;
  }
}
