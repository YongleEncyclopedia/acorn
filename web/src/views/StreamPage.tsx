import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ListFilter, Menu as MenuIcon, MoreHorizontal, Pause, Pencil, RefreshCw } from "lucide-react";
import { Layout, streamPath, VIEW_TITLES, type Stream } from "./Layout.tsx";
import { EntryList } from "./EntryList.tsx";
import { EntryReader } from "./EntryReader.tsx";
import { Empty } from "../components/Empty.tsx";
import { Popover, Menu, useAnchor } from "../components/Popover.tsx";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { useBootstrap, useEntries, useEntryActions, keys } from "../lib/queries.ts";
import { api, type EntryQuery } from "../lib/api.ts";
import { relTime, todayHeading, hostname, greeting } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { useMobile } from "../lib/useMedia.ts";
import type { EntrySummary, Feed } from "../../../src/shared/types.ts";

function useUnreadFilter(stream: Stream): [boolean, (v: boolean) => void] {
  const key = `acorn.unread.${stream.kind}`;
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return [
    v,
    (x) => {
      setV(x);
      try {
        localStorage.setItem(key, x ? "1" : "0");
      } catch {
        /* ignore */
      }
    },
  ];
}

export function StreamPage({ stream, entryId }: { stream: Stream; entryId: number | null }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const mobile = useMobile();
  const boot = useBootstrap();
  const fresh = ui.use((s) => s.freshEntries);
  const [unreadOnly, setUnreadOnly] = useUnreadFilter(stream);
  const markMenu = useAnchor();
  const moreMenu = useAnchor();
  const { setRead, setStar } = useEntryActions();

  const query: EntryQuery = useMemo(() => {
    if (stream.kind === "view") return { view: stream.view };
    if (stream.kind === "feed") return { feed: stream.id, unread: unreadOnly || undefined };
    return { folder: stream.id, unread: unreadOnly || undefined };
  }, [stream, unreadOnly]);
  const list = useEntries(query);
  const entries = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // The "new entries" pill only makes sense for arrivals after the list was loaded.
  useEffect(() => {
    ui.set({ freshEntries: 0 });
  }, [list.dataUpdatedAt]);
  const feeds = useMemo(() => new Map<number, Feed>((boot.data?.feeds || []).map((f) => [f.id, f])), [boot.data?.feeds]);
  const feed = stream.kind === "feed" ? feeds.get(stream.id) : undefined;
  const folder = stream.kind === "folder" ? boot.data?.folders.find((f) => f.id === stream.id) : undefined;

  const title = stream.kind === "view" ? VIEW_TITLES[stream.view] : feed?.title || folder?.name || "…";
  const subtitle =
    stream.kind === "view"
      ? stream.view === "today"
        ? `${greeting()} · ${todayHeading()}`
        : stream.view === "unread"
          ? `${boot.data?.counts.unread ?? 0} 篇未读`
          : stream.view === "starred"
            ? "标记过的文章，会自动入藏"
            : stream.view === "progress"
              ? "读到一半的文章"
              : ""
      : feed
        ? `${hostname(feed.siteUrl || feed.url) || feed.kind}${feed.lastSuccessAt ? ` · ${relTime(feed.lastSuccessAt)}更新` : ""}`
        : `${(boot.data?.feeds || []).filter((f) => f.folderId === stream.id).length} 个订阅源`;

  const idx = entryId ? entries.findIndex((e) => e.id === entryId) : -1;
  const next = idx >= 0 ? entries[idx + 1] || null : null;
  const prev = idx > 0 ? entries[idx - 1] : null;

  const open = useCallback((e: EntrySummary) => navigate(streamPath(stream, e.id)), [navigate, stream]);
  const go = (delta: number) => {
    const target = idx < 0 ? entries[0] : entries[idx + delta];
    if (target) open(target);
    if (delta > 0 && idx >= entries.length - 4 && list.hasNextPage) list.fetchNextPage();
  };
  const back = () => navigate(streamPath(stream));

  const onSwipe = useCallback(
    (e: EntrySummary, dir: "left" | "right") => {
      if (dir === "right") setRead.mutate({ entry: e, read: !e.readAt });
      else setStar.mutate({ entry: e, starred: !e.starredAt });
    },
    [setRead, setStar],
  );

  const markAll = async () => {
    try {
      const body =
        stream.kind === "feed" ? { feedId: stream.id } : stream.kind === "folder" ? { folderId: stream.id } : { view: stream.view === "today" ? ("today" as const) : undefined };
      const r = await api.mark({ ...body, before: Date.now() });
      toast(r.changed ? `已将 ${r.changed} 篇标为已读` : "没有未读文章");
      qc.invalidateQueries({ queryKey: ["entries"] });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (e) {
      toastError(e);
    }
  };
  const refresh = async () => {
    if (fresh) ui.set({ freshEntries: 0 });
    if (stream.kind === "feed") {
      try {
        const r = await api.refreshFeed(stream.id, true);
        toast(r.error ? `刷新失败：${r.error}` : r.added ? `新到 ${r.added} 篇` : "没有新文章", { kind: r.error ? "error" : "info" });
      } catch (e) {
        toastError(e);
      }
    }
    await list.refetch();
    qc.invalidateQueries({ queryKey: keys.bootstrap });
  };

  useHotkeys({
    j: () => go(1),
    k: () => go(-1),
    ArrowDown: () => !entryId && go(1),
    ArrowUp: () => !entryId && go(-1),
    r: refresh,
    "shift+a": markAll,
    "g u": () => navigate("/s/unread"),
    "g t": () => navigate("/s/today"),
    "g s": () => navigate("/s/starred"),
    "g a": () => navigate("/archive"),
    "g n": () => navigate("/notes"),
  });

  const listPane = (
    <section className="pane list-pane">
      <header className="pane-head">
        <button className="icon-btn menu-btn" onClick={() => ui.set({ drawer: true })} aria-label="打开导航">
          <MenuIcon size={20} />
        </button>
        {feed && <FeedIcon feed={feed} large />}
        <div className="titles">
          <h1>{title}</h1>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        {stream.kind !== "view" && (
          <button className="icon-btn" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)} title={unreadOnly ? "显示全部" : "只看未读"} aria-label="只看未读">
            <ListFilter size={18} />
          </button>
        )}
        <button className="icon-btn" onClick={refresh} title="刷新（R）" aria-label="刷新">
          <RefreshCw size={17} className={list.isFetching && !list.isFetchingNextPage ? "spin-slow" : ""} />
        </button>
        <button ref={markMenu.ref} className="icon-btn" onClick={markMenu.toggle} title="全部标为已读（Shift+A）" aria-label="全部标为已读">
          <CheckCheck size={18} />
        </button>
        {feed && (
          <button ref={moreMenu.ref} className="icon-btn" onClick={moreMenu.toggle} aria-label="更多">
            <MoreHorizontal size={18} />
          </button>
        )}
      </header>
      {fresh > 0 && (
        <button className="fresh-pill" onClick={refresh}>
          有新文章 · 点击刷新
        </button>
      )}
      <div className="list-scroll scroll">
        {list.isLoading ? (
          <div style={{ padding: "8px 18px" }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ padding: "14px 0", borderBottom: "1px solid var(--line)" }}>
                <div className="skeleton" style={{ height: 11, width: "35%", marginBottom: 10 }} />
                <div className="skeleton" style={{ height: 15, width: "92%", marginBottom: 7 }} />
                <div className="skeleton" style={{ height: 15, width: "64%" }} />
              </div>
            ))}
          </div>
        ) : entries.length ? (
          <EntryList
            entries={entries}
            feeds={feeds}
            selectedId={entryId}
            showSource={stream.kind !== "feed"}
            hasMore={!!list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
            onOpen={open}
            onSwipe={onSwipe}
            groupByDay={stream.kind !== "view" || !["starred", "progress", "archived"].includes(stream.view)}
            titleLang={boot.data?.settings.translate.titles ? boot.data.settings.translate.targetLang : null}
          />
        ) : !boot.data?.feeds.length ? (
          <Empty
            art="acorn"
            title="松果还空着"
            action={
              <button className="btn primary" onClick={() => ui.set({ addSource: {} })}>
                添加第一个订阅
              </button>
            }
          >
            粘贴一个网址、RSS、RSSHub 路由，或者学院通知页，松果会自己认出来。
          </Empty>
        ) : (
          <Empty art="inbox" title={stream.kind === "view" && stream.view === "starred" ? "稍后读是空的" : "都读完了"}>
            {stream.kind === "view" && stream.view === "starred" ? "在文章上按 S 加入稍后读，松果会顺手把它入藏。" : "新文章到达时会出现在这里。"}
          </Empty>
        )}
      </div>
      {markMenu.open && (
        <Popover anchor={markMenu.el} onClose={markMenu.close}>
          <div className="menu-note">把「{title}」里截至现在的文章全部标为已读？</div>
          <Menu items={[{ label: "全部标为已读", icon: <CheckCheck size={15} />, onSelect: markAll }]} onClose={markMenu.close} />
        </Popover>
      )}
      {moreMenu.open && feed && (
        <Popover anchor={moreMenu.el} onClose={moreMenu.close}>
          <Menu
            onClose={moreMenu.close}
            items={[
              { label: "编辑订阅源", icon: <Pencil size={15} />, onSelect: () => navigate(`/sources?edit=${feed.id}`) },
              {
                label: feed.paused ? "恢复更新" : "暂停更新",
                icon: <Pause size={15} />,
                onSelect: () => api.patchFeed(feed.id, { paused: !feed.paused }).then(() => qc.invalidateQueries({ queryKey: keys.bootstrap }), toastError),
              },
            ]}
            note={feed.lastError ? `上次抓取失败：${feed.lastError}` : undefined}
          />
        </Popover>
      )}
    </section>
  );

  const readerPane = (
    <main className="pane reader-pane">
      {entryId ? (
        <EntryReader id={entryId} next={next} onBack={back} onNext={() => next && open(next)} />
      ) : (
        <Empty art="acorn" title="选一篇文章读读">
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
            <kbd>J</kbd>
            <kbd>K</kbd> 上下篇 <kbd>S</kbd> 稍后读 <kbd>A</kbd> 入藏 <kbd>T</kbd> 翻译 <kbd>I</kbd> 要点 <kbd>⌘K</kbd> 搜索
          </span>
        </Empty>
      )}
    </main>
  );
  void prev;

  return (
    <Layout mode="three" view={entryId ? "reader" : "list"}>
      {(!mobile || !entryId) && listPane}
      {(!mobile || entryId) && readerPane}
    </Layout>
  );
}
