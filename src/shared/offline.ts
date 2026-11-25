/**
 * The offline pack (离线包): which pictures an article needs on a device that reads it without a connection,
 * and the changes (read, 稍后读, progress) the device made meanwhile, kept until the server can be reached.
 * Dependency-free like the rest of src/shared: the web app runs it in the browser, the tests on linkedom.
 */
import type { EntrySummary } from "./types.ts";

export interface ArticleImages {
  /** The pictures to store, as the reader asks for them (proxied: /api/img?u=…). */
  urls: string[];
  /**
   * `srcset` candidates mapped to the stored picture of the same image. The browser picks a candidate by screen
   * size, so storing one per image is enough only if the others can stand in: the service worker answers a missing
   * candidate with its stored picture.
   */
  aliases: Record<string, string>;
}

/** Only what the server serves can be stored; data: URIs need nothing. */
const storable = (u: string | null | undefined): u is string => !!u && (u.startsWith("/api/img?") || u.startsWith("/files/"));

/** The URLs of a `srcset`, in order (the server writes them comma-and-space separated, see api/content.ts). */
export function srcsetUrls(srcset: string | null | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(/,\s+(?=\S)/)
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** The pictures of an article's HTML (parsed by DOMParser in the browser, linkedom in tests). */
export function articleImages(doc: ParentNode): ArticleImages {
  const urls = new Set<string>();
  const aliases: Record<string, string> = {};
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const candidates = srcsetUrls(img.getAttribute("srcset"));
    // in a <picture> the browser may take a <source> instead of the <img>
    const picture = img.parentElement?.tagName.toLowerCase() === "picture" ? img.parentElement : null;
    if (picture) for (const s of Array.from(picture.querySelectorAll("source"))) candidates.push(...srcsetUrls(s.getAttribute("srcset")));
    const src = img.getAttribute("src");
    // without a src, the last candidate: srcsets usually go from small to large
    const stored = storable(src) ? src : candidates.filter(storable).at(-1);
    if (!stored) continue;
    urls.add(stored);
    for (const c of candidates) if (storable(c) && c !== stored) aliases[c] = stored;
  }
  for (const video of Array.from(doc.querySelectorAll("video[poster]"))) {
    const poster = video.getAttribute("poster");
    if (storable(poster)) urls.add(poster);
  }
  // a picture stored in its own right answers for itself
  for (const u of urls) delete aliases[u];
  return { urls: [...urls], aliases };
}

/** A change to an article made while the server could not be reached. */
export interface EntryChange {
  read?: boolean;
  starred?: boolean;
  progress?: number;
  /** When it was last changed: a change sent while a newer one was made is not dropped by mistake. */
  at: number;
}

/** Waiting changes by article id. */
export type Outbox = Record<string, EntryChange>;

/** Add a change; later changes to the same article win, field by field. */
export function addChange(box: Outbox, id: number, change: Omit<EntryChange, "at">, at = Date.now()): Outbox {
  const fields = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  return { ...box, [id]: { ...box[id], ...fields, at } };
}

/** Forget fields of a waiting change that the server has just been given anew (they are no longer waiting). */
export function dropFields(box: Outbox, id: number, fields: string[]): Outbox {
  const c = box[id];
  if (!c) return box;
  const rest = Object.fromEntries(Object.entries(c).filter(([k]) => k !== "at" && !fields.includes(k)));
  const next = { ...box };
  if (Object.keys(rest).length) next[id] = { ...rest, at: c.at };
  else delete next[id];
  return next;
}

/** An article as this device sees it: as the server (or the stored copy) has it, with the changes not yet sent. */
export function withChanges<T extends Pick<EntrySummary, "id" | "readAt" | "starredAt" | "progress">>(entry: T, box: Outbox): T {
  const c = box[entry.id];
  if (!c) return entry;
  const out = { ...entry };
  if (c.read !== undefined) out.readAt = c.read ? (entry.readAt ?? c.at) : null;
  if (c.starred !== undefined) out.starredAt = c.starred ? (entry.starredAt ?? c.at) : null;
  if (c.progress !== undefined) out.progress = c.progress;
  return out;
}
