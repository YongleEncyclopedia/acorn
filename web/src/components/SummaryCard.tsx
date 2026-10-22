import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Sparkles, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { toast } from "../lib/store.ts";
import type { ArticleSummary } from "../../../src/shared/types.ts";

type Target = { entryId: number } | { archiveId: number };

export interface SummaryState {
  data: ArticleSummary | null | undefined;
  open: boolean;
  busy: boolean;
  error: string | null;
  /** Show the summary, making it first if needed; hide it if it is showing. */
  toggle: () => void;
  regenerate: () => void;
  close: () => void;
}

/** Key points for one article: cached ones show up by themselves, new ones are made on request. */
export function useSummary(target: Target, contentKey: string, ready = true): SummaryState {
  const qc = useQueryClient();
  const key = ["summary", target, contentKey];
  const cached = useQuery({ queryKey: key, queryFn: () => api.summary({ ...target }).then((r) => r.summary).catch(() => null), staleTime: Infinity, enabled: ready });
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOpen(true);
    setError(null);
  }, [contentKey]);
  const make = async (fresh: boolean) => {
    setBusy(true);
    setError(null);
    setOpen(true);
    try {
      const r = await api.summary({ ...target, generate: true, fresh });
      qc.setQueryData(key, r.summary);
    } catch (e) {
      const msg = (e as Error).message;
      if (/太短/.test(msg)) {
        toast(msg);
        setOpen(false);
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  };
  return {
    data: cached.data,
    open,
    busy,
    error,
    toggle: () => {
      if (busy) return;
      if (cached.data && open) setOpen(false);
      else if (cached.data) setOpen(true);
      else void make(false);
    },
    regenerate: () => void make(true),
    close: () => {
      setOpen(false);
      setError(null);
    },
  };
}

export function SummaryCard({ s }: { s: SummaryState }) {
  if (!s.open || (!s.data && !s.busy && !s.error)) return null;
  return (
    <section className="tldr" aria-live="polite">
      <header>
        <Sparkles size={15} />
        <b>要点</b>
        {s.data && !s.busy && <span className="muted">· {s.data.model}</span>}
        <span className="grow" />
        {s.data && !s.busy && (
          <button className="icon-btn sm" title="重新生成" aria-label="重新生成要点" onClick={s.regenerate}>
            <RotateCw size={14} />
          </button>
        )}
        <button className="icon-btn sm" title="收起" aria-label="收起要点" onClick={s.close}>
          <X size={15} />
        </button>
      </header>
      {s.busy ? (
        <div className="tldr-wait">
          <span className="spinner" />
          正在提炼要点…
        </div>
      ) : s.error ? (
        <div className="tldr-wait bad">
          没能生成要点：{s.error}
          <Link href="/settings#translate">检查模型设置</Link>
        </div>
      ) : (
        <ul>
          {s.data!.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
