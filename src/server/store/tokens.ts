import type { Db } from "../db/index.ts";
import { randomToken, sha256 } from "../util/text.ts";

export interface TokenInfo {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** API tokens for the CLI, MCP server, Google Reader clients and scripts. Only hashes are stored. */
export class TokenStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(name: string): { token: string; info: TokenInfo } {
    const token = `acorn_${randomToken(24)}`;
    const id = this.db.run("insert into tokens (name, hash, created_at) values (?, ?, ?)", name, sha256(token), Date.now()).lastInsertRowid;
    return { token, info: { id, name, createdAt: Date.now(), lastUsedAt: null } };
  }

  verify(token: string): TokenInfo | null {
    if (!token) return null;
    const r = this.db.get<{ id: number; name: string; created_at: number; last_used_at: number | null }>(
      "select id, name, created_at, last_used_at from tokens where hash = ?",
      sha256(token),
    );
    if (!r) return null;
    if (!r.last_used_at || Date.now() - r.last_used_at > 60_000) this.db.run("update tokens set last_used_at = ? where id = ?", Date.now(), r.id);
    return { id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at };
  }

  list(): TokenInfo[] {
    return this.db
      .all<{ id: number; name: string; created_at: number; last_used_at: number | null }>("select * from tokens order by id")
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  delete(id: number): boolean {
    return this.db.run("delete from tokens where id = ?", id).changes > 0;
  }

  deleteByName(name: string): void {
    this.db.run("delete from tokens where name = ?", name);
  }
}
