import type { Db } from "../db/index.ts";

/** Cached machine translations, keyed by the hash of the source text. */
export class TranslationStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(hashes: string[], lang: string): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < hashes.length; i += 500) {
      const part = hashes.slice(i, i + 500);
      const rows = this.db.all<{ hash: string; text: string }>(
        `select hash, text from translations where lang = ? and hash in (${part.map(() => "?").join(",")})`,
        lang,
        ...part,
      );
      for (const r of rows) out.set(r.hash, r.text);
    }
    return out;
  }

  put(hash: string, lang: string, text: string, model: string): void {
    this.db.run(
      "insert into translations (hash, lang, text, model, created_at) values (?, ?, ?, ?, ?) on conflict(hash, lang) do update set text = excluded.text, model = excluded.model, created_at = excluded.created_at",
      hash,
      lang,
      text,
      model,
      Date.now(),
    );
  }

  forget(hashes: string[], lang: string): void {
    for (const h of hashes) this.db.run("delete from translations where hash = ? and lang = ?", h, lang);
  }
}
