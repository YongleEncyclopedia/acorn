import { DatabaseSync } from "node:sqlite";
import type { Db } from "../db/index.ts";
import type { Account } from "../../shared/types.ts";

/** Cookies by host ("my.sjtu.edu.cn") or by domain (".sjtu.edu.cn"), then by name. */
export type Jar = Record<string, Record<string, string>>;

/** What signs a request in: a token (sent as the platform expects), a cookie header, or the cookies of a browser sign-in. */
export interface Credential {
  token?: string;
  cookie?: string;
  /** For sign-ins that span hosts, such as a portal and the single sign-on that renews it (交我办 and jAccount). */
  jar?: Jar;
}

interface AccountRow {
  id: number;
  service: string;
  origin: string;
  name: string;
  secret: string;
  status: Account["status"];
  error: string | null;
  checked_at: number | null;
  created_at: number;
  feeds: number;
}

// how many subscriptions read with each account (their config names it as plugin.account)
const SELECT = `select a.*, (select count(*) from feeds f where json_extract(f.config, '$.plugin.account') = a.id) as feeds from accounts a`;

const stringify = (c: Credential): string => JSON.stringify({ token: c.token || undefined, cookie: c.cookie || undefined, jar: c.jar && Object.keys(c.jar).length ? c.jar : undefined });

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  service: r.service,
  origin: r.origin,
  name: r.name,
  status: r.status,
  error: r.error,
  checkedAt: r.checked_at,
  createdAt: r.created_at,
  feeds: r.feeds,
});

/**
 * A copy of the database that leaves this computer (the full export, the backup directory, which may sit in
 * iCloud or on a NAS) keeps the accounts but not their sign-ins: after a restore, each one asks to sign in again.
 */
export function forgetSecrets(dbFile: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    // overwrite what is cleared, then rebuild the file: an older token can linger in free space otherwise
    db.exec("pragma secure_delete = on");
    db.exec("update accounts set secret = '{}', status = 'expired', error = '这是从副本恢复的账号：登录信息不随副本保存，请重新登录'");
    // 班级日历: the classmates' links are theirs, the Feishu secret and the .ics key are the owner's
    db.exec("delete from calendar_member_events; delete from calendar_members; delete from calendar_sync");
    db.exec("update settings set value = json_set(value, '$.feishuAppSecret', '', '$.icsKey', '') where key = '_classCalendar'");
    db.exec("vacuum");
  } finally {
    db.close();
  }
}

/** Sign-ins to platforms (知识星球, Canvas…). `secret` is for the server's own requests; Account never carries it. */
export class AccountStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): Account[] {
    return this.db.all<AccountRow>(`${SELECT} order by a.service, a.origin`).map(toAccount);
  }

  get(id: number): Account | undefined {
    const r = this.db.get<AccountRow>(`${SELECT} where a.id = ?`, id);
    return r ? toAccount(r) : undefined;
  }

  credential(id: number): (Credential & { account: Account }) | undefined {
    const r = this.db.get<AccountRow>(`${SELECT} where a.id = ?`, id);
    if (!r) return undefined;
    let secret: Credential = {};
    try {
      secret = JSON.parse(r.secret) as Credential;
    } catch {
      /* treated as no credential: the platform will say the sign-in does not work */
    }
    return { token: secret.token, cookie: secret.cookie, jar: secret.jar, account: toAccount(r) };
  }

  /** A new sign-in, or a fresh one for a platform already signed in to (its subscriptions carry on with it). */
  save(service: string, origin: string, name: string, credential: Credential): Account {
    const secret = stringify(credential);
    const now = Date.now();
    this.db.run(
      `insert into accounts (service, origin, name, secret, status, error, checked_at, created_at) values (?, ?, ?, ?, 'ok', null, ?, ?)
       on conflict(service, origin) do update set name = excluded.name, secret = excluded.secret, status = 'ok', error = null, checked_at = excluded.checked_at`,
      service,
      origin,
      name,
      secret,
      now,
      now,
    );
    const r = this.db.get<{ id: number }>("select id from accounts where service = ? and origin = ?", service, origin)!;
    return this.get(r.id)!;
  }

  /** A sign-in renewed along the way (a new portal session): kept so the next request starts from it. */
  updateSecret(id: number, credential: Credential): void {
    this.db.run("update accounts set secret = ? where id = ?", stringify(credential), id);
  }

  setStatus(id: number, status: Account["status"], error: string | null = null): void {
    this.db.run("update accounts set status = ?, error = ?, checked_at = ? where id = ?", status, error, Date.now(), id);
  }

  /** The platform just accepted the sign-in. */
  markWorking(id: number): void {
    this.db.run("update accounts set status = 'ok', error = null, checked_at = ? where id = ? and status <> 'ok'", Date.now(), id);
  }

  delete(id: number): boolean {
    return this.db.run("delete from accounts where id = ?", id).changes > 0;
  }

  /** The accounts signed in at an address (without counting their subscriptions: the image proxy asks often). */
  atOrigin(origin: string): { id: number; service: string; status: Account["status"] }[] {
    return this.db.all<{ id: number; service: string; status: Account["status"] }>("select id, service, status from accounts where origin = ?", origin);
  }

  /** The subscriptions that read with an account. */
  feedIds(id: number): number[] {
    return this.db.all<{ id: number }>("select id from feeds where json_extract(config, '$.plugin.account') = ?", id).map((r) => r.id);
  }
}
