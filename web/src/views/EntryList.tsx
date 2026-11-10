import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkCheck, CircleCheck, CircleDot, Highlighter } from "lucide-react";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Seal } from "../components/Seal.tsx";
import { dayKey, dayLabel, relTime } from "../lib/format.ts";
import { useTranslation } from "../lib/translate.ts";
import { needsTranslation, sourceKey } from "../../../src/shared/translate.ts";
import type { EntrySummary, Feed } from "../../../src/shared/types.ts";

/** How far into an article you are. */
export function Ring({ p, size = 15 }: { p: number; size?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className="progress-ring" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={`已读 ${Math.round(p * 100)}%`}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

const thumb = (url: string, referer: string | null) => `/api/img?u=${encodeURIComponent(url)}${referer ? `&r=${encodeURIComponent(referer)}` : ""}`;

/** What can be done to an entry without opening it: by swipe on a phone, from the hover buttons with a mouse. */
export type EntryAction = "read" | "star";

interface ItemProps {
  entry: EntrySummary;
  feed: Feed | undefined;
  selected: boolean;
  showSource: boolean;
  compact: boolean;
  titleTr?: string;
  onOpen: (e: EntrySummary) => void;
  onAction: (e: EntrySummary, action: EntryAction) => void;
  onMenu: (e: EntrySummary, at: { x: number; y: number }) => void;
}

const Item = memo(function Item({ entry, feed, selected, showSource, compact, titleTr, onOpen, onAction, onMenu }: ItemProps) {
  const [dx, setDx] = useState(0);
  const [imgOk, setImgOk] = useState(true);
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const read = !!entry.readAt;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    start.current = { x: e.clientX, y: e.clientY, active: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.active) {
      if (Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.6) s.active = true;
      else if (Math.abs(my) > 10) {
        start.current = null;
        return;
      }
    }
    if (s.active) setDx(Math.max(-140, Math.min(140, mx)));
  };
  const onPointerUp = () => {
    if (start.current?.active && Math.abs(dx) > 84) onAction(entry, dx > 0 ? "read" : "star");
    start.current = null;
    setDx(0);
  };
  return (
    <article
      ref={ref}
      className={`entry ${read ? "read" : ""}`}
      aria-current={selected}
      onClick={() => !Math.abs(dx) && onOpen(entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(entry, { x: e.clientX, y: e.clientY });
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={dx ? { transform: `translateX(${dx}px)`, transition: "none", touchAction: "pan-y" } : { touchAction: "pan-y" }}
    >
      {!!dx && (
        <div className="swipe-bg" style={{ background: dx > 0 ? "var(--ink-3)" : "var(--accent)", transform: `translateX(${-dx}px)` }}>
          <span style={{ opacity: dx > 0 ? 1 : 0 }}>{read ? "标为未读" : "标为已读"}</span>
          <span style={{ opacity: dx < 0 ? 1 : 0 }}>{entry.starredAt ? "移出稍后读" : "稍后读"}</span>
        </div>
      )}
      <span className="unread-dot" />
      <div className="entry-main">
        <div className="entry-meta">
          {showSource && (
            <>
              <FeedIcon feed={feed} />
              <span className="src">{feed?.title || "…"}</span>
              <span>·</span>
            </>
          )}
          <span className="time">{relTime(entry.publishedAt || entry.createdAt)}</span>
          <span className="flags">
            {entry.progress > 0.02 && entry.progress < 0.97 && <Ring p={entry.progress} />}
            {entry.highlightCount > 0 && <Highlighter size={13} />}
            {entry.starredAt && <Bookmark size={13} className="star" fill="currentColor" />}
            {entry.archiveId && <Seal size="xs" />}
          </span>
        </div>
        <h3 className="entry-title">{entry.title}</h3>
        {titleTr && <div className="entry-title-tr">{titleTr}</div>}
        {entry.summary && !compact && <p className="entry-excerpt">{entry.summary}</p>}
        {/* for the mouse; the keyboard has M and S, a phone swipes */}
        <div className="entry-actions" onClick={(e) => e.stopPropagation()}>
          <button tabIndex={-1} title={read ? "标为未读" : "标为已读"} aria-label={read ? "标为未读" : "标为已读"} onClick={() => onAction(entry, "read")}>
            {read ? <CircleDot size={15} /> : <CircleCheck size={15} />}
          </button>
          <button tabIndex={-1} title={entry.starredAt ? "移出稍后读" : "稍后读"} aria-label={entry.starredAt ? "移出稍后读" : "稍后读"} onClick={() => onAction(entry, "star")}>
            {entry.starredAt ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
          </button>
        </div>
      </div>
      {entry.image && imgOk && !compact && <img className="entry-thumb" src={thumb(entry.image, entry.url)} alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} />}
    </article>
  );
});

export function EntryList({
  entries,
  feeds,
  selectedId,
  showSource,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onAction,
  onMenu,
  groupByDay,
  compact = false,
  titleLang = null,
}: {
  entries: EntrySummary[];
  feeds: Map<number, Feed>;
  selectedId: number | null;
  showSource: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (e: EntrySummary) => void;
  onAction: (e: EntrySummary, action: EntryAction) => void;
  onMenu: (e: EntrySummary, at: { x: number; y: number }) => void;
  groupByDay: boolean;
  /** Titles only: no excerpts or pictures. */
  compact?: boolean;
  /** Translate foreign-language titles into this language (null = off). */
  titleLang?: string | null;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((xs) => xs.some((x) => x.isIntersecting) && onLoadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, entries.length]);

  // Titles in another language get a translation underneath; keep what earlier pages already got.
  const foreign = useMemo(() => (titleLang ? [...new Set(entries.map((e) => sourceKey(e.title)).filter((t) => needsTranslation(t, titleLang)))] : []), [entries, titleLang]);
  const tr = useTranslation(() => foreign, { key: foreign.join("\n"), title: "", enabled: foreign.length > 0, lang: titleLang || "zh-CN" });
  const titleTr = useRef(new Map<string, string>());
  for (const [k, v] of tr.map) if (sourceKey(v) !== k) titleTr.current.set(k, v);

  const groups = useMemo(() => {
    if (!groupByDay) return [{ key: 0, label: "", items: entries }];
    const out: { key: number; label: string; items: EntrySummary[] }[] = [];
    for (const e of entries) {
      const k = dayKey(e.publishedAt && e.publishedAt <= Date.now() + 864e5 ? e.publishedAt : e.createdAt);
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(e);
      else out.push({ key: k, label: dayLabel(k), items: [e] });
    }
    return out;
  }, [entries, groupByDay]);

  return (
    <div className="entry-list" data-density={compact ? "compact" : undefined}>
      {groups.map((g) => (
        <section key={g.key}>
          {g.label && (
            <div className="day-head">
              {g.label}
              <span className="n">{g.items.length}</span>
            </div>
          )}
          {g.items.map((e) => (
            <Item key={e.id} entry={e} feed={feeds.get(e.feedId)} selected={e.id === selectedId} showSource={showSource} compact={compact} titleTr={titleLang ? titleTr.current.get(sourceKey(e.title)) : undefined} onOpen={onOpen} onAction={onAction} onMenu={onMenu} />
          ))}
        </section>
      ))}
      <div ref={sentinel} />
      {loadingMore && (
        <div className="list-end">
          <span className="spinner" style={{ display: "inline-block" }} />
        </div>
      )}
      {!hasMore && entries.length > 6 && <div className="list-end">· 到底了 ·</div>}
    </div>
  );
}
