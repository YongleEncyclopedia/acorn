import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { keys } from "../lib/queries.ts";
import { toastError } from "../lib/store.ts";
import type { ReaderTranslation } from "../lib/translate.ts";
import type { TranslateSettings } from "../../../src/shared/types.ts";

/** One line above the article while translation is on: progress, errors, display mode. */
export function TranslateStatus({ tr, cfg }: { tr: ReaderTranslation; cfg: TranslateSettings | undefined }) {
  const qc = useQueryClient();
  if (!tr.on) return null;
  if (tr.error) {
    return (
      <div className="reader-banner">
        <span>翻译失败：{tr.error}</span>
        <button className="btn sm act" onClick={tr.retry}>
          重试
        </button>
        <Link href="/settings#translate" className="btn sm ghost">
          翻译设置
        </Link>
      </div>
    );
  }
  const setDisplay = async (display: "bilingual" | "only") => {
    if (!cfg) return;
    await api.patchSettings({ translate: { ...cfg, display } }).catch(toastError);
    qc.invalidateQueries({ queryKey: keys.bootstrap });
  };
  const job = tr.job;
  return (
    <div className="tr-status">
      {tr.pending ? (
        <>
          <span className="spinner" />
          <span>正在翻译{job ? ` ${job.done}/${job.total}` : "…"}</span>
        </>
      ) : (
        <span>机器翻译{job?.model ? ` · ${job.model}` : ""}</span>
      )}
      <span className="grow" />
      <button className="link-btn" onClick={() => setDisplay(tr.display === "only" ? "bilingual" : "only")}>
        {tr.display === "only" ? "双语对照" : "只看译文"}
      </button>
      {!tr.pending && (
        <button className="link-btn" onClick={tr.retranslate}>
          重新翻译
        </button>
      )}
    </div>
  );
}
