import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../util/log.ts";

const log = logger("db");
const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/**
 * Thin wrapper over node:sqlite with a statement cache and typed helpers.
 * Every query in the app goes through these four methods.
 */
export class Db {
  raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000; pragma synchronous = normal;");
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Nested-safe transaction (uses savepoints for inner calls). */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.depth += 1;
    this.raw.exec(this.depth === 1 ? "begin immediate" : `savepoint ${name}`);
    try {
      const out = fn();
      this.raw.exec(this.depth === 1 ? "commit" : `release ${name}`);
      return out;
    } catch (err) {
      this.raw.exec(this.depth === 1 ? "rollback" : `rollback to ${name}`);
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }

  private migrate(): void {
    const current = Number((this.raw.prepare("pragma user_version").get() as { user_version: number }).user_version);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = Number(file.split("_")[0]);
      if (version <= current) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      this.raw.exec("begin immediate");
      try {
        this.raw.exec(sql);
        this.raw.exec(`pragma user_version = ${version}`);
        this.raw.exec("commit");
        log.info(`applied migration ${file}`);
      } catch (err) {
        this.raw.exec("rollback");
        throw err;
      }
    }
  }
}

/** Escape a user query for FTS5 trigram matching. Returns null when too short for trigram (use LIKE). */
export function ftsQuery(q: string): string | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/"/g, '""'));
  if (!terms.length || terms.some((t) => [...t].length < 3)) return null;
  return terms.map((t) => `"${t}"`).join(" AND ");
}

export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
