import type { Db } from "../db/index.ts";
import type { Settings, TranslateSettings } from "../../shared/types.ts";
import { isMaskedKey, KEY_MASK, keyTarget, presetById, presetFor, REASONING_CHOICES } from "../../shared/ai.ts";

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
  translate: {
    provider: "ollama",
    preset: "ollama",
    baseUrl: "",
    model: "qwen3:8b",
    apiKey: "",
    reasoning: "auto",
    contextLength: 0,
    extraBody: "",
    targetLang: "zh-CN",
    auto: false,
    titles: false,
    display: "bilingual",
  },
  backup: { dir: "", auto: false, cron: "0 3 * * *" },
  network: { proxy: "system", url: "", bypass: "localhost, 127.0.0.1, ::1, .local" },
};

/**
 * The AI settings made whole: settings saved before presets existed get the preset their address belongs to, and a
 * preset that no longer matches the protocol (the protocol was changed through the API) is worked out again.
 */
export function normalizeTranslate(t: TranslateSettings): TranslateSettings {
  const known = presetById(t.preset);
  const preset = known && known.protocol === t.provider ? known : presetFor(t.provider, t.baseUrl);
  return {
    ...t,
    preset: preset.id,
    reasoning: REASONING_CHOICES.includes(t.reasoning) ? t.reasoning : "auto",
    contextLength: Number.isFinite(t.contextLength) && t.contextLength > 0 ? Math.min(Math.round(t.contextLength), 100_000_000) : 0,
    extraBody: typeof t.extraBody === "string" ? t.extraBody.trim() : "",
  };
}

/** Settings as sent to clients: secrets are masked (the last 4 characters stay so the user can tell keys apart). */
export function publicSettings(s: Settings): Settings {
  const key = s.translate.apiKey;
  return key ? { ...s, translate: { ...s.translate, apiKey: `${KEY_MASK}${key.slice(-4)}` } } : s;
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
      translate: normalizeTranslate({ ...DEFAULT_SETTINGS.translate, ...(parsed.translate || {}), ...(parsed.translate && !parsed.translate.preset ? { preset: "" } : {}) }),
      backup: { ...DEFAULT_SETTINGS.backup, ...(parsed.backup || {}) },
      network: { ...DEFAULT_SETTINGS.network, ...(parsed.network || {}) },
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
      // a new protocol or address without a preset (the CLI, older clients) means the preset has to be worked out again
      translate: { ...cur.translate, ...(patch.translate || {}), ...(patch.translate && !patch.translate.preset && (patch.translate.provider || patch.translate.baseUrl !== undefined) ? { preset: "" } : {}) },
      backup: { ...cur.backup, ...(patch.backup || {}) },
      network: { ...cur.network, ...(patch.network || {}) },
    };
    const maskedKey = patch.translate?.apiKey !== undefined && isMaskedKey(patch.translate.apiKey);
    if (maskedKey) next.translate.apiKey = cur.translate.apiKey;
    next.defaultInterval = Math.max(5, Math.min(24 * 60, Math.round(next.defaultInterval)));
    next.recheckDays = Math.max(0, Math.min(365, Math.round(next.recheckDays)));
    next.retentionDays = Math.max(0, Math.round(next.retentionDays));
    next.rsshubBase = (next.rsshubBase || "").trim().replace(/\/+$/, "");
    next.wechatBridge.url = (next.wechatBridge.url || "").trim().replace(/\/+$/, "");
    next.wechatBridge.folder = (next.wechatBridge.folder || "").trim() || DEFAULT_SETTINGS.wechatBridge.folder;
    next.translate.baseUrl = (next.translate.baseUrl || "").trim().replace(/\/+$/, "");
    next.translate.model = (next.translate.model || "").trim();
    next.translate.apiKey = (next.translate.apiKey || "").trim();
    next.translate = normalizeTranslate(next.translate);
    // the masked key stands for the saved one only where that one was entered for (see keyTarget)
    if (maskedKey && keyTarget(next.translate) !== keyTarget(cur.translate)) next.translate.apiKey = "";
    next.backup.dir = (next.backup.dir || "").trim().replace(/[\\/]+$/, "");
    next.backup.cron = (next.backup.cron || "").trim() || DEFAULT_SETTINGS.backup.cron;
    if (!["system", "manual", "off"].includes(next.network.proxy)) next.network.proxy = "system";
    next.network.url = (next.network.url || "").trim();
    // a bare "127.0.0.1:7897" is an HTTP proxy
    if (next.network.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(next.network.url)) next.network.url = `http://${next.network.url}`;
    next.network.bypass = (next.network.bypass ?? "").trim() || DEFAULT_SETTINGS.network.bypass;
    this.setRaw("app", JSON.stringify(next));
    return next;
  }
}
