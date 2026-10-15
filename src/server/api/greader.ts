/**
 * Google Reader–compatible API (the dialect implemented by FreshRSS and Miniflux), so native apps such as
 * Reeder, NetNewsWire, Read You, Capy Reader and NewsFlash can sync with Acorn.
 *
 * Server URL for clients: http(s)://<host>:<port>  (or .../api/greader for apps that want a path)
 * Login: any username + your Acorn password (or an API token). Starring in a client archives the article in Acorn.
 */
import type { Hono, Context } from "hono";
import type { App } from "../app.ts";
import type { Param } from "../db/index.ts";
import { bearer, verifyPassword } from "./auth.ts";
import { addFeed } from "../feeds/add.ts";
import { queueCapture } from "../archive/capture.ts";

const READING = "user/-/state/com.google/reading-list";
const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";
const KEPT_UNREAD = "user/-/state/com.google/kept-unread";
const LABEL = "user/-/label/";

type Params = Record<string, string[]>;

async function params(c: Context): Promise<Params> {
  const out: Params = {};
  const add = (k: string, v: string) => {
    (out[k] ||= []).push(v);
  };
  const url = new URL(c.req.url);
  for (const [k, v] of url.searchParams) add(k, v);
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string") add(k, x);
    }
  }
  return out;
}

const one = (p: Params, k: string) => p[k]?.[0];

function longId(id: number): string {
  return `tag:google.com,2005:reader/item/${id.toString(16).padStart(16, "0")}`;
}

function parseItemId(s: string): number | null {
  if (s.startsWith("tag:")) return parseInt(s.slice(s.lastIndexOf("/") + 1), 16);
  if (/^-?\d+$/.test(s)) return Number(BigInt.asUintN(64, BigInt(s)));
  if (/^[0-9a-f]{16}$/i.test(s)) return parseInt(s, 16);
  return null;
}

function authed(app: App, c: Context): boolean {
  const t = bearer(c);
  return !!(t && app.tokens.verify(t));
}

interface StreamFilter {
  where: string[];
  params: Param[];
}

function streamFilter(app: App, stream: string | undefined, p: Params): StreamFilter {
  const where: string[] = [];
  const vals: Param[] = [];
  const s = stream || READING;
  if (s === STARRED) where.push("e.starred_at is not null");
  else if (s === READ) where.push("e.read_at is not null");
  else if (s.startsWith("feed/")) {
    const ref = s.slice(5);
    const id = /^\d+$/.test(ref) ? Number(ref) : app.feeds.list().find((f) => f.url === ref)?.id ?? -1;
    where.push("e.feed_id = ?");
    vals.push(id);
  } else if (s.startsWith(LABEL)) {
    where.push("e.feed_id in (select f.id from feeds f join folders d on d.id = f.folder_id where d.name = ?)");
    vals.push(decodeURIComponent(s.slice(LABEL.length)));
  }
  for (const xt of p.xt || []) {
    if (xt === READ) where.push("e.read_at is null");
    if (xt === STARRED) where.push("e.starred_at is null");
  }
  for (const it of p.it || []) {
    if (it === READ) where.push("e.read_at is not null");
    if (it === STARRED) where.push("e.starred_at is not null");
  }
  const ot = Number(one(p, "ot") || 0);
  if (ot) {
    where.push("e.sort_at >= ?");
    vals.push(ot * 1000);
  }
  const nt = Number(one(p, "nt") || 0);
  if (nt) {
    where.push("e.sort_at <= ?");
    vals.push(nt * 1000);
  }
  return { where, params: vals };
}

function queryIds(app: App, stream: string | undefined, p: Params, maxN: number): { ids: { id: number; ts: number }[]; continuation: string | null } {
  const { where, params: vals } = streamFilter(app, stream, p);
  const n = Math.min(Math.max(Number(one(p, "n") || 20), 1), maxN);
  const offset = Number(one(p, "c") || 0) || 0;
  const asc = one(p, "r") === "o";
  const rows = app.db.all<{ id: number; ts: number }>(
    `select e.id, e.sort_at as ts from entries e ${where.length ? `where ${where.join(" and ")}` : ""}
     order by e.sort_at ${asc ? "asc" : "desc"}, e.id ${asc ? "asc" : "desc"} limit ? offset ?`,
    ...vals,
    n + 1,
    offset,
  );
  return { ids: rows.slice(0, n), continuation: rows.length > n ? String(offset + n) : null };
}

interface ItemRow {
  id: number;
  feed_id: number;
  url: string | null;
  title: string;
  author: string | null;
  content: string | null;
  full_content: string | null;
  published_at: number | null;
  created_at: number;
  sort_at: number;
  read_at: number | null;
  starred_at: number | null;
  image: string | null;
}

function items(app: App, ids: number[]) {
  if (!ids.length) return [];
  const feeds = new Map(app.feeds.list().map((f) => [f.id, f]));
  const folders = new Map(app.feeds.folders().map((f) => [f.id, f.name]));
  const rows = app.db.all<ItemRow>(`select * from entries e where e.id in (${ids.map(() => "?").join(",")})`, ...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is ItemRow => !!r)
    .map((r) => {
      const feed = feeds.get(r.feed_id);
      const cats = [READING];
      if (r.read_at) cats.push(READ);
      if (r.starred_at) cats.push(STARRED);
      const folder = feed?.folderId ? folders.get(feed.folderId) : null;
      if (folder) cats.push(`${LABEL}${folder}`);
      const item: Record<string, unknown> = {
        id: longId(r.id),
        crawlTimeMsec: String(r.created_at),
        timestampUsec: String(r.sort_at * 1000),
        published: Math.floor((r.published_at || r.created_at) / 1000),
        updated: Math.floor((r.published_at || r.created_at) / 1000),
        title: r.title,
        canonical: r.url ? [{ href: r.url }] : [],
        alternate: r.url ? [{ href: r.url, type: "text/html" }] : [],
        categories: cats,
        origin: { streamId: `feed/${r.feed_id}`, title: feed?.title || "", htmlUrl: feed?.siteUrl || "" },
        summary: { content: r.full_content || r.content || "" },
        author: r.author || "",
      };
      if (r.image) item.enclosure = [{ href: r.image, type: "image/jpeg" }];
      return item;
    });
}

function setTags(app: App, ids: number[], add: string[], remove: string[]): void {
  const archiveOnStar = app.settings.all().archiveOnStar;
  if (add.includes(READ)) app.entries.setRead(ids, true);
  if (remove.includes(READ) || add.includes(KEPT_UNREAD)) app.entries.setRead(ids, false);
  for (const id of ids) {
    if (add.includes(STARRED)) {
      app.entries.setStarred(id, true);
      const row = app.entries.row(id);
      if (archiveOnStar && row?.url && !app.archives.byEntry(id)) queueCapture(app, { url: row.url, entryId: id, method: "fetch" });
    }
    if (remove.includes(STARRED)) app.entries.setStarred(id, false);
  }
  app.events.emit({ type: "counts" });
}

function register(r: Hono, app: App, prefix: string): void {
  const api = `${prefix}/reader/api/0`;

  r.post(`${prefix}/accounts/ClientLogin`, async (c) => {
    const p = await params(c);
    const pass = one(p, "Passwd") || "";
    const ok = verifyPassword(pass, app.settings.getRaw("_password")) || !!app.tokens.verify(pass);
    if (!ok) return c.text("Error=BadAuthentication\n", 401);
    const name = "Google Reader 客户端";
    const existing = app.tokens.list().filter((t) => t.name === name);
    for (const t of existing.slice(0, Math.max(0, existing.length - 7))) app.tokens.delete(t.id);
    const { token } = app.tokens.create(name);
    return c.text(`SID=${token}\nLSID=null\nAuth=${token}\n`);
  });

  r.use(`${api}/*`, async (c, next) => {
    if (!authed(app, c)) return c.text("Unauthorized", 401);
    return next();
  });

  r.get(`${api}/token`, (c) => c.text("acorn-greader-token\n"));
  r.get(`${api}/user-info`, (c) => c.json({ userId: "1", userName: "acorn", userProfileId: "1", userEmail: "acorn@localhost" }));

  r.get(`${api}/subscription/list`, (c) => {
    const folders = new Map(app.feeds.folders().map((f) => [f.id, f.name]));
    const origin = new URL(c.req.url).origin;
    return c.json({
      subscriptions: app.feeds.list().map((f) => ({
        id: `feed/${f.id}`,
        title: f.title,
        categories: f.folderId && folders.get(f.folderId) ? [{ id: `${LABEL}${folders.get(f.folderId)}`, label: folders.get(f.folderId) }] : [],
        url: f.kind === "feed" ? f.url : `${origin}/feed/${f.id}`,
        htmlUrl: f.siteUrl || "",
        iconUrl: f.hasIcon ? `${origin}/api/icons/${f.id}` : "",
      })),
    });
  });

  r.get(`${api}/tag/list`, (c) =>
    c.json({ tags: [{ id: STARRED }, ...app.feeds.folders().map((f) => ({ id: `${LABEL}${f.name}`, type: "folder" }))] }),
  );

  r.get(`${api}/unread-count`, (c) => {
    const rows = app.db.all<{ feed_id: number; n: number; newest: number }>(
      "select feed_id, count(*) n, max(sort_at) newest from entries where read_at is null group by feed_id",
    );
    const feeds = new Map(app.feeds.list().map((f) => [f.id, f]));
    const folders = new Map(app.feeds.folders().map((f) => [f.id, f.name]));
    const byFolder = new Map<string, { n: number; newest: number }>();
    let total = 0;
    let newestAll = 0;
    const out = rows.map((r) => {
      total += r.n;
      newestAll = Math.max(newestAll, r.newest);
      const fid = feeds.get(r.feed_id)?.folderId;
      const name = fid ? folders.get(fid) : null;
      if (name) {
        const cur = byFolder.get(name) || { n: 0, newest: 0 };
        byFolder.set(name, { n: cur.n + r.n, newest: Math.max(cur.newest, r.newest) });
      }
      return { id: `feed/${r.feed_id}`, count: r.n, newestItemTimestampUsec: String(r.newest * 1000) };
    });
    for (const [name, v] of byFolder) out.push({ id: `${LABEL}${name}`, count: v.n, newestItemTimestampUsec: String(v.newest * 1000) });
    out.push({ id: READING, count: total, newestItemTimestampUsec: String(newestAll * 1000) });
    return c.json({ max: total, unreadcounts: out });
  });

  r.get(`${api}/stream/items/ids`, async (c) => {
    const p = await params(c);
    const { ids, continuation } = queryIds(app, one(p, "s"), p, 10_000);
    return c.json({ itemRefs: ids.map((x) => ({ id: String(x.id), directStreamIds: [], timestampUsec: String(x.ts * 1000) })), ...(continuation ? { continuation } : {}) });
  });

  const contents = async (c: Context) => {
    const p = await params(c);
    const ids = (p.i || []).map(parseItemId).filter((x): x is number => x !== null);
    return c.json({ id: READING, updated: Math.floor(Date.now() / 1000), items: items(app, ids) });
  };
  r.post(`${api}/stream/items/contents`, contents);
  r.get(`${api}/stream/items/contents`, contents);

  r.get(`${api}/stream/contents/*`, async (c) => {
    const p = await params(c);
    const stream = decodeURIComponent(c.req.path.slice(`${api}/stream/contents/`.length)) || one(p, "s");
    const { ids, continuation } = queryIds(app, stream, p, 1000);
    return c.json({ id: stream, updated: Math.floor(Date.now() / 1000), items: items(app, ids.map((x) => x.id)), ...(continuation ? { continuation } : {}) });
  });

  r.post(`${api}/edit-tag`, async (c) => {
    const p = await params(c);
    const ids = (p.i || []).map(parseItemId).filter((x): x is number => x !== null);
    setTags(app, ids, p.a || [], p.r || []);
    return c.text("OK");
  });

  r.post(`${api}/mark-all-as-read`, async (c) => {
    const p = await params(c);
    const s = one(p, "s") || READING;
    const ts = Number(one(p, "ts") || 0);
    const before = ts ? Math.floor(ts / 1000) : undefined;
    if (s.startsWith("feed/")) app.entries.markRead({ feedId: Number(s.slice(5)) || -1, before });
    else if (s.startsWith(LABEL)) {
      const folder = app.feeds.folderByName(decodeURIComponent(s.slice(LABEL.length)));
      if (folder) app.entries.markRead({ folderId: folder.id, before });
    } else app.entries.markRead({ before });
    app.events.emit({ type: "counts" });
    return c.text("OK");
  });

  r.post(`${api}/subscription/quickadd`, async (c) => {
    const p = await params(c);
    const q = one(p, "quickadd") || "";
    const res = await addFeed(app, { input: q.replace(/^feed\//, "") });
    return c.json({ numResults: 1, query: q, streamId: `feed/${res.feed.id}`, streamName: res.feed.title });
  });

  r.post(`${api}/subscription/edit`, async (c) => {
    const p = await params(c);
    const ac = one(p, "ac");
    const s = one(p, "s") || "";
    const label = (v?: string) => (v?.startsWith(LABEL) ? decodeURIComponent(v.slice(LABEL.length)) : null);
    const ref = s.replace(/^feed\//, "");
    let feed = /^\d+$/.test(ref) ? app.feeds.get(Number(ref)) : app.feeds.list().find((f) => f.url === ref);
    if (ac === "subscribe") {
      const folderName = label(one(p, "a")) || undefined;
      const res = await addFeed(app, { input: ref, title: one(p, "t"), folderName });
      feed = res.feed;
    } else if (ac === "unsubscribe" && feed) {
      app.feeds.delete(feed.id);
    } else if (ac === "edit" && feed) {
      if (one(p, "t")) app.feeds.update(feed.id, { customTitle: one(p, "t")! });
      const add = label(one(p, "a"));
      if (add) app.feeds.update(feed.id, { folderId: app.feeds.createFolder(add).id });
      else if (label(one(p, "r"))) app.feeds.update(feed.id, { folderId: null });
    }
    app.events.emit({ type: "counts" });
    return c.text("OK");
  });

  r.post(`${api}/rename-tag`, async (c) => {
    const p = await params(c);
    const from = one(p, "s")?.replace(LABEL, "");
    const to = one(p, "dest")?.replace(LABEL, "");
    const folder = from ? app.feeds.folderByName(decodeURIComponent(from)) : undefined;
    if (folder && to) app.feeds.updateFolder(folder.id, { name: decodeURIComponent(to) });
    return c.text("OK");
  });

  r.post(`${api}/disable-tag`, async (c) => {
    const p = await params(c);
    const name = one(p, "s")?.replace(LABEL, "");
    const folder = name ? app.feeds.folderByName(decodeURIComponent(name)) : undefined;
    if (folder) app.feeds.deleteFolder(folder.id);
    return c.text("OK");
  });
}

export function registerGReader(r: Hono, app: App): void {
  register(r, app, "");
  register(r, app, "/api/greader");
}
