import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Highlighter } from "lucide-react";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Seal } from "../components/Seal.tsx";
import { dayKey, dayLabel, relTime } from "../lib/format.ts";
import { useTranslation } from "../lib/translate.ts";
import { needsTranslation, sourceKey } from "../../../src/shared/translate.ts";
import type { EntrySummary, Feed } from "../../../src/shared/types.ts";

function Ring({ p }: { p: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className="progress-ring" width="15" height="15" viewBox="0 0 16 16" aria-label={`已读 ${Math.round(p * 100)}%`}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

const thumb = (url: string, referer: string | null) => `/api/img?u=${encodeURIComponent(url)}${referer ? `&r=${encodeURIComponent(referer)}` : ""}`;

interface ItemProps {
  entry: EntrySummary;
  feed: Feed | undefined;
  selected: boolean;
  showSource: boolean;
  titleTr?: string;
  onOpen: (e: EntrySummary) => void;
  onSwipe: (e: EntrySummary, dir: "left" | "right") => void;
}

const Item = memo(function Item({ entry, feed, selected, showSource, titleTr, onOpen, onSwipe }: ItemProps) {
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
    if (start.current?.active && Math.abs(dx) > 84) onSwipe(entry, dx > 0 ? "right" : "left");
    start.current = null;
    setDx(0);
  };
  return (
    <article
      ref={ref}
      className={`entry ${read ? "read" : ""}`}
      aria-current={selected}
      onClick={() => !Math.abs(dx) && onOpen(entry)}
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
      <div style={{ minWidth: 0 }}>
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
        {entry.summary && <p className="entry-excerpt">{entry.summary}</p>}
      </div>
      {entry.image && imgOk && <img className="entry-thumb" src={thumb(entry.image, entry.url)} alt="" loading="lazy" decoding="async" onError={() => setImgOk(false)} />}
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
  onSwipe,
  groupByDay,
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
  onSwipe: (e: EntrySummary, dir: "left" | "right") => void;
  groupByDay: boolean;
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
    <div>
      {groups.map((g) => (
        <section key={g.key}>
          {g.label && (
            <div className="day-head">
              {g.label}
              <span className="n">{g.items.length}</span>
            </div>
          )}
          {g.items.map((e) => (
            <Item key={e.id} entry={e} feed={feeds.get(e.feedId)} selected={e.id === selectedId} showSource={showSource} titleTr={titleLang ? titleTr.current.get(sourceKey(e.title)) : undefined} onOpen={onOpen} onSwipe={onSwipe} />
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
