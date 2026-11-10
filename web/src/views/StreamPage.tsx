import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpToLine, Bookmark, CheckCheck, CircleCheck, CircleDot, Copy, ExternalLink, History, Menu as MenuIcon, MoreHorizontal, Pause, Pencil, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Layout, streamPath, VIEW_TITLES, type Stream } from "./Layout.tsx";
import { EntryList, type EntryAction } from "./EntryList.tsx";
import { EntryReader } from "./EntryReader.tsx";
import { ReaderHome } from "./ReaderHome.tsx";
import { Empty } from "../components/Empty.tsx";
import { Popover, Menu, useAnchor, type MenuItem } from "../components/Popover.tsx";
import { Segmented, Switch } from "../components/Controls.tsx";
import { FeedIcon } from "../components/FeedIcon.tsx";
import { Seal } from "../components/Seal.tsx";
import { useBootstrap, useEntries, useEntryActions, keys } from "../lib/queries.ts";
import { api, type EntryQuery } from "../lib/api.ts";
import { relTime, todayHeading, hostname, greeting } from "../lib/format.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { useLocal, useLocalFlag } from "../lib/local.ts";
import { useDocumentTitle, useFocusMode } from "../lib/shell.ts";
import { useMobile } from "../lib/useMedia.ts";
import type { EntrySummary, Feed } from "../../../src/shared/types.ts";

/**
 * Where the list was scrolled to when an article was opened from it. A phone shows either the list or the
 * article and both scroll the page, so coming back has to put the list where it was. One trip only: it is
 * used up on the way back and dropped as soon as any other list is shown.
 */
let leftListAt: { path: string; y: number } | null = null;


export function StreamPage({ stream, entryId }: { stream: Stream; entryId: number | null }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const mobile = useMobile();
  const boot = useBootstrap();
  const fresh = ui.use((s) => s.freshEntries);
  // How the list is shown is remembered on this device: the filter and order per kind of list, the density overall.
  const [unreadPref, setUnreadOnly] = useLocalFlag(`acorn.unread.${stream.kind}`);
  const [order, setOrder] = useLocal<"new" | "old">(`acorn.order.${stream.kind}`, "new", ["new", "old"]);
  const [density, setDensity] = useLocal<"comfortable" | "compact">("acorn.density", "comfortable", ["comfortable", "compact"]);
  const [focus] = useFocusMode();
  const viewMenu = useAnchor();
  const markMenu = useAnchor();
  const moreMenu = useAnchor();
  // `at` is kept as one object: the popover re-measures whenever its anchor changes identity.
  const [entryMenu, setEntryMenu] = useState<{ entry: EntrySummary; at: { x: number; y: number } } | null>(null);
  const { setRead, setStar } = useEntryActions();
  // 未读 is already a filter; 稍后读, 在读 and 已入藏 are lists you keep regardless of read state.
  const canFilter = stream.kind !== "view" || stream.view === "today" || stream.view === "all";
  const unreadOnly = canFilter && unreadPref;

  const query: EntryQuery = useMemo(() => {
    const how = { unread: unreadOnly || undefined, order: order === "old" ? ("old" as const) : undefined };
    if (stream.kind === "view") return { view: stream.view, ...how };
    if (stream.kind === "feed") return { feed: stream.id, ...how };
    return { folder: stream.id, ...how };
  }, [stream, unreadOnly, order]);
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
  useDocumentTitle(entryId ? undefined : title);

  // Back from an article on a phone: the list returns to where it was left (it used to jump to the top).
  const path = streamPath(stream);
  const here = useRef({ mobile, entryId, path });
  here.current = { mobile, entryId, path };
  useLayoutEffect(() => {
    if (!mobile || entryId) return;
    const y = leftListAt?.path === path ? leftListAt.y : 0;
    leftListAt = null;
    window.scrollTo(0, y);
  }, [mobile, entryId, path]);
  useEffect(() => () => void (leftListAt = null), []);

  const open = useCallback(
    (e: EntrySummary) => {
      const at = here.current;
      if (at.mobile && !at.entryId) leftListAt = { path: at.path, y: window.scrollY };
      navigate(streamPath(stream, e.id));
    },
    [navigate, stream],
  );

  // Reading on from article to article (Space, the 下一篇 card, a phone) reaches the end of what is loaded
  // without the list ever scrolling, or even being on screen: fetch the next page as the end comes near.
  const nearEnd = idx >= 0 && idx >= entries.length - 4;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [nearEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const go = (delta: number) => {
    const target = idx < 0 ? entries[0] : entries[idx + delta];
    if (target) open(target);
  };
  const back = () => navigate(streamPath(stream));

  const onAction = useCallback(
    (e: EntrySummary, action: EntryAction) => {
      if (action === "read") setRead.mutate({ entry: e, read: !e.readAt });
      else setStar.mutate({ entry: e, starred: !e.starredAt });
    },
    [setRead, setStar],
  );
  const onMenu = useCallback((entry: EntrySummary, at: { x: number; y: number }) => setEntryMenu({ entry, at }), []);

  /** Which entries "everything in this list" means to the server. */
  const scope = stream.kind === "feed" ? { feedId: stream.id } : stream.kind === "folder" ? { folderId: stream.id } : { view: stream.view === "today" ? ("today" as const) : undefined };
  const markRange = async (range: { before?: number; upTo?: number; newerThan?: number }) => {
    try {
      const r = await api.mark({ ...scope, ...range });
      toast(r.changed ? `已将 ${r.changed} 篇标为已读` : "没有未读文章");
      qc.invalidateQueries({ queryKey: ["entries"] });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (e) {
      toastError(e);
    }
  };
  /** Mark everything here as read, or only what was published more than `days` ago. */
  const markAll = (days = 0) => markRange({ before: Date.now() - days * 86_400_000 });
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
    // The arrows walk the list only while no article is open; once one is, they are left alone so that they
    // scroll it (registering them at all would swallow the key).
    ...(entryId ? {} : { ArrowDown: () => go(1), ArrowUp: () => go(-1) }),
    r: refresh,
    "shift+a": () => markAll(),
    "g u": () => navigate("/s/unread"),
    "g t": () => navigate("/s/today"),
    "g s": () => navigate("/s/starred"),
    "g a": () => navigate("/archive"),
    "g n": () => navigate("/notes"),
  });

  // 稍后读, 在读 and 已入藏 are ordered by when you did that, not by when the article was published.
  const byTime = stream.kind !== "view" || !["starred", "progress", "archived"].includes(stream.view);

  /** The right-click menu of a list entry. */
  const entryItems = (e: EntrySummary): (MenuItem | "sep")[] => [
    { label: e.readAt ? "标为未读" : "标为已读", icon: e.readAt ? <CircleDot size={15} /> : <CircleCheck size={15} />, onSelect: () => onAction(e, "read") },
    { label: e.starredAt ? "移出稍后读" : "稍后读", icon: <Bookmark size={15} />, onSelect: () => onAction(e, "star") },
    ...(!e.archiveId && e.url ? [{ label: "入藏", icon: <Seal size="xs" />, onSelect: () => api.capture({ entryId: e.id }).then(() => toast("正在入藏…"), toastError) }] : []),
    ...(byTime
      ? [
          "sep" as const,
          { label: "比这篇新的都标为已读", icon: <ArrowUpToLine size={15} />, onSelect: () => markRange({ newerThan: e.id }) },
          { label: "这篇和更早的都标为已读", icon: <ArrowDownToLine size={15} />, onSelect: () => markRange({ upTo: e.id }) },
        ]
      : []),
    ...(e.url
      ? [
          "sep" as const,
          { label: "打开原文", icon: <ExternalLink size={15} />, onSelect: () => void window.open(e.url!, "_blank", "noopener,noreferrer") },
          { label: "复制链接", icon: <Copy size={15} />, onSelect: () => void navigator.clipboard?.writeText(e.url!).then(() => toast("已复制链接")) },
        ]
      : []),
  ];

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
        <button ref={viewMenu.ref} className="icon-btn" aria-pressed={unreadOnly || order === "old"} onClick={viewMenu.toggle} title="显示方式" aria-label="显示方式">
          <SlidersHorizontal size={17} />
        </button>
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
            onAction={onAction}
            onMenu={onMenu}
            compact={density === "compact"}
            groupByDay={byTime}
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
      {viewMenu.open && (
        <Popover anchor={viewMenu.el} onClose={viewMenu.close} label="显示方式">
          <div className="view-opts">
            {canFilter && (
              <label className="row">
                <span>只看未读</span>
                <Switch checked={unreadOnly} onChange={setUnreadOnly} label="只看未读" />
              </label>
            )}
            <div className="row">
              <span>排序</span>
              <Segmented
                value={order}
                onChange={setOrder}
                options={[
                  { value: "new", label: "最新在前" },
                  { value: "old", label: "最早在前" },
                ]}
              />
            </div>
            <div className="row">
              <span>密度</span>
              <Segmented
                value={density}
                onChange={setDensity}
                options={[
                  { value: "comfortable", label: "舒适" },
                  { value: "compact", label: "紧凑" },
                ]}
              />
            </div>
          </div>
        </Popover>
      )}
      {entryMenu && (
        <Popover anchor={entryMenu.at} onClose={() => setEntryMenu(null)} placement="bottom-start">
          <Menu items={entryItems(entryMenu.entry)} onClose={() => setEntryMenu(null)} />
        </Popover>
      )}
      {markMenu.open && (
        <Popover anchor={markMenu.el} onClose={markMenu.close}>
          <div className="menu-note">把「{title}」里的文章标为已读</div>
          <Menu
            items={[
              { label: "全部", icon: <CheckCheck size={15} />, onSelect: () => markAll() },
              { label: "一天前发布的", icon: <History size={15} />, onSelect: () => markAll(1) },
              { label: "三天前发布的", icon: <History size={15} />, onSelect: () => markAll(3) },
              { label: "一周前发布的", icon: <History size={15} />, onSelect: () => markAll(7) },
            ]}
            onClose={markMenu.close}
          />
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
      {entryId ? <EntryReader id={entryId} next={next} onBack={back} onNext={() => next && open(next)} /> : <ReaderHome first={entries[0] || null} onOpen={open} />}
    </main>
  );

  return (
    <Layout mode="three" view={entryId ? "reader" : "list"} focus={focus}>
      {(!mobile || !entryId) && listPane}
      {(!mobile || entryId) && readerPane}
    </Layout>
  );
}
