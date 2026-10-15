import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, type EntryQuery } from "./api.ts";
import type { Bootstrap, Entry, EntrySummary, Page } from "../../../src/shared/types.ts";
import { toast, toastError } from "./store.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401 && (err as { status?: number }).status !== 404 },
  },
});

export const keys = {
  bootstrap: ["bootstrap"] as const,
  entries: (q: EntryQuery) => ["entries", q] as const,
  entry: (id: number) => ["entry", id] as const,
  archives: (p: object) => ["archives", p] as const,
  archive: (id: number, snap?: number) => ["archive", id, snap ?? 0] as const,
  highlights: (q: string) => ["highlights", q] as const,
};

export function useBootstrap() {
  return useQuery({ queryKey: keys.bootstrap, queryFn: api.bootstrap, staleTime: 15_000 });
}

export function useEntries(q: EntryQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.entries(q),
    queryFn: ({ pageParam }) => api.entries(q, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 60_000,
  });
}

export function useEntry(id: number | null) {
  return useQuery({ queryKey: keys.entry(id ?? 0), queryFn: () => api.entry(id!), enabled: !!id, staleTime: 5 * 60_000 });
}

/** Apply a change to an entry everywhere it is cached (lists + detail). */
export function patchEntryCaches(qc: QueryClient, id: number, patch: Partial<EntrySummary>): void {
  qc.setQueriesData<InfiniteData<Page<EntrySummary>>>({ queryKey: ["entries"] }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((e) => (e.id === id ? { ...e, ...patch } : e)) })) }
      : data,
  );
  qc.setQueryData<Entry>(keys.entry(id), (e) => (e ? { ...e, ...patch } : e));
}

function bumpCounts(qc: QueryClient, feedId: number, unreadDelta: number, starDelta = 0): void {
  qc.setQueryData<Bootstrap>(keys.bootstrap, (b) =>
    b
      ? {
          ...b,
          counts: { ...b.counts, unread: Math.max(0, b.counts.unread + unreadDelta), starred: Math.max(0, b.counts.starred + starDelta) },
          feeds: b.feeds.map((f) => (f.id === feedId ? { ...f, unread: Math.max(0, f.unread + unreadDelta) } : f)),
        }
      : b,
  );
}

export function useEntryActions() {
  const qc = useQueryClient();
  const setRead = useMutation({
    mutationFn: ({ entry, read }: { entry: EntrySummary; read: boolean }) => api.patchEntry(entry.id, { read }),
    onMutate: ({ entry, read }) => {
      if (!!entry.readAt === read) return;
      patchEntryCaches(qc, entry.id, { readAt: read ? Date.now() : null });
      bumpCounts(qc, entry.feedId, read ? -1 : 1);
    },
    onError: (err) => {
      toastError(err);
      qc.invalidateQueries({ queryKey: ["entries"] });
      qc.invalidateQueries({ queryKey: keys.bootstrap });
    },
  });
  const setStar = useMutation({
    mutationFn: ({ entry, starred }: { entry: EntrySummary; starred: boolean }) => api.patchEntry(entry.id, { starred }),
    onMutate: ({ entry, starred }) => {
      patchEntryCaches(qc, entry.id, { starredAt: starred ? Date.now() : null });
      bumpCounts(qc, entry.feedId, 0, starred ? 1 : -1);
    },
    onSuccess: (_d, { starred }) => {
      const b = qc.getQueryData<Bootstrap>(keys.bootstrap);
      if (starred && b?.settings.archiveOnStar) toast("已加入稍后读，正在入藏…");
    },
    onError: toastError,
  });
  const setProgress = useMutation({
    mutationFn: ({ id, progress }: { id: number; progress: number }) => api.patchEntry(id, { progress }),
    onMutate: ({ id, progress }) => patchEntryCaches(qc, id, { progress }),
  });
  return { setRead, setStar, setProgress };
}

export function invalidateAll(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: keys.bootstrap });
  qc.invalidateQueries({ queryKey: ["entries"] });
}
