import { EventEmitter } from "node:events";
import { writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { Db } from "./db/index.ts";
import { SettingsStore } from "./store/settings.ts";
import { FeedStore } from "./store/feeds.ts";
import { EntryStore } from "./store/entries.ts";
import { ArchiveStore } from "./store/archives.ts";
import { HighlightStore } from "./store/highlights.ts";
import { TokenStore } from "./store/tokens.ts";
import { TranslationStore } from "./store/translations.ts";
import { JobQueue } from "./jobs.ts";
import type { Counts, ServerEvent } from "../shared/types.ts";

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  emit(ev: ServerEvent): void {
    this.emitter.emit("event", ev);
  }
  on(fn: (ev: ServerEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}

/** Everything a request handler or background job needs. Created once per process. */
export interface App {
  cfg: Config;
  db: Db;
  settings: SettingsStore;
  feeds: FeedStore;
  entries: EntryStore;
  archives: ArchiveStore;
  highlights: HighlightStore;
  tokens: TokenStore;
  translations: TranslationStore;
  events: EventBus;
  /** Network-bound background work (refresh, full text, archive). */
  jobs: JobQueue;
}

export function createApp(cfg: Config): App {
  const db = new Db(cfg.dbPath);
  return {
    cfg,
    db,
    settings: new SettingsStore(db),
    feeds: new FeedStore(db),
    entries: new EntryStore(db),
    archives: new ArchiveStore(db),
    highlights: new HighlightStore(db),
    tokens: new TokenStore(db),
    translations: new TranslationStore(db),
    events: new EventBus(),
    jobs: new JobQueue(5, 1500),
  };
}

export function counts(app: App): Counts {
  const r = app.db.get<Record<string, number>>(
    `select
      (select count(*) from entries where read_at is null) as unread,
      (select count(*) from entries where read_at is null and sort_at >= ?) as today,
      (select count(*) from entries where starred_at is not null) as starred,
      (select count(*) from archives) as archived,
      (select count(*) from entries where progress > 0.02 and progress < 0.97) as in_progress,
      (select count(*) from highlights) as highlights,
      (select count(*) from archives where source_status = 'gone') as gone,
      (select count(*) from feeds) as feeds,
      (select count(*) from feeds where error_count > 0) as failing`,
    Date.now() - 86_400_000,
  )!;
  return {
    unread: r.unread,
    today: r.today,
    starred: r.starred,
    archived: r.archived,
    inProgress: r.in_progress,
    highlights: r.highlights,
    gone: r.gone,
    feeds: r.feeds,
    failing: r.failing,
  };
}

/** The CLI and MCP server authenticate with a token stored in data/.cli-token (mode 600). */
export function ensureCliToken(app: App): string {
  const file = path.join(app.cfg.dataDir, ".cli-token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (app.tokens.verify(token)) return token;
  }
  app.tokens.deleteByName("cli (local)");
  const { token } = app.tokens.create("cli (local)");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
