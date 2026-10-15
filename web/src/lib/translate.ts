/**
 * Immersive translation in the reader: each translatable block gets its translation right below it
 * (or in its place, for "only"). Inserted nodes carry TR_ATTR so highlights and block detection ignore them.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "./api.ts";
import { TR_ATTR, blockText, isForeign, needsTranslation, sourceKey, translatableBlocks } from "../../../src/shared/translate.ts";
import type { TranslateSettings, TranslationJob } from "../../../src/shared/types.ts";
import type { ArticleHandle } from "../views/ArticleView.tsx";

const ORIG_ATTR = "data-acorn-orig";
const SRC_ATTR = "data-tr-src";
// Blocks whose translation goes inside them (a <div> after an <li> or <td> would break the list or table).
const INSIDE = new Set(["LI", "TD", "TH", "DD", "DT", "SUMMARY", "FIGCAPTION", "BLOCKQUOTE"]);

export interface ShownTranslation {
  map: Map<string, string>;
  display: "bilingual" | "only";
  lang: string;
}

export function blockTexts(root: HTMLElement, lang: string): string[] {
  return translatableBlocks(root, lang).map((el) => sourceKey(blockText(el)));
}

export function clearTranslation(root: HTMLElement): void {
  for (const el of root.querySelectorAll(`[${TR_ATTR}]`)) el.remove();
  for (const span of root.querySelectorAll(`[${ORIG_ATTR}]`)) span.replaceWith(...span.childNodes);
  for (const el of root.querySelectorAll(`[${SRC_ATTR}]`)) el.removeAttribute(SRC_ATTR);
  root.removeAttribute("data-tr");
}

export function applyTranslation(root: HTMLElement, tr: ShownTranslation | null | undefined): void {
  clearTranslation(root);
  if (!tr || !tr.map.size) return;
  root.dataset.tr = tr.display;
  for (const el of translatableBlocks(root, tr.lang)) {
    const source = sourceKey(blockText(el));
    const text = tr.map.get(source);
    if (!text || sourceKey(text) === source) continue; // names, code… that stay as they are
    if (INSIDE.has(el.tagName)) {
      const orig = document.createElement("span");
      orig.setAttribute(ORIG_ATTR, "");
      orig.append(...el.childNodes);
      const t = document.createElement("span");
      t.setAttribute(TR_ATTR, "");
      t.className = "tr";
      t.lang = tr.lang;
      t.textContent = text;
      el.append(orig, t);
    } else {
      const t = document.createElement(/^(H[1-6]|P)$/.test(el.tagName) ? el.tagName : "DIV");
      t.setAttribute(TR_ATTR, "");
      t.className = "tr";
      t.lang = tr.lang;
      t.textContent = text;
      el.setAttribute(SRC_ATTR, "");
      el.after(t);
    }
  }
}

export interface TranslationState {
  job: TranslationJob | null;
  /** Source text → translation, for what has been translated so far. */
  map: Map<string, string>;
  title: string | null;
  error: string | null;
  pending: boolean;
  retry: () => void;
  retranslate: () => void;
}

/** Ask the server to translate the article's blocks (and title) while `enabled`, polling until it is done. */
export function useTranslation(read: () => string[], deps: { key: string; title: string; enabled: boolean; lang: string }): TranslationState {
  const { key, title, enabled, lang } = deps;
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    setJob(null);
    setError(null);
    setTexts([]);
    if (!enabled) return;
    const all = [...(needsTranslation(title, lang) ? [sourceKey(title)] : []), ...read()];
    setTexts(all);
    if (!all.length) return;
    let live = true;
    api
      .translate(all, lang, fresh.current)
      .then((j) => live && setJob(j))
      .catch((e: Error) => live && setError(e.message));
    fresh.current = false;
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, title, enabled, lang, nonce]);

  const pending = !!job && !job.error && job.done < job.total;
  useEffect(() => {
    if (!pending || !job) return;
    let live = true;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.translation(job.id);
        if (live) setJob(next);
      } catch {
        // the server forgot the job (restart): ask again
        if (live) setNonce((n) => n + 1);
      }
    }, 1200);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [pending, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const map = useMemo(() => {
    const m = new Map<string, string>();
    if (job) texts.forEach((t, i) => job.items[i] && m.set(t, job.items[i]!));
    return m;
  }, [job, texts]);

  return {
    job,
    map,
    title: ((t) => (t && sourceKey(t) !== sourceKey(title) ? t : null))(map.get(sourceKey(title))),
    error: error || job?.error || null,
    pending: enabled && !error && texts.length > 0 && (!job || pending),
    retry: () => setNonce((n) => n + 1),
    retranslate: () => {
      fresh.current = true;
      setNonce((n) => n + 1);
    },
  };
}

export interface ReaderTranslation extends TranslationState {
  on: boolean;
  foreign: boolean;
  lang: string;
  display: "bilingual" | "only";
  shown: ShownTranslation | null;
  toggle: () => void;
}

/** Translation for one open article: off by default, on automatically for foreign-language text when the user wants that. */
export function useReaderTranslation(article: RefObject<ArticleHandle | null>, opts: { id: string; html: string; title: string; cfg: TranslateSettings | undefined }): ReaderTranslation {
  const { id, html, title, cfg } = opts;
  const lang = cfg?.targetLang || "zh-CN";
  const display = cfg?.display || "bilingual";
  const [manual, setManual] = useState<boolean | null>(null);
  const [foreign, setForeign] = useState(false);
  useEffect(() => setManual(null), [id]);
  useEffect(() => {
    setForeign(isForeign(`${title}\n${article.current?.el?.textContent || ""}`, lang));
  }, [html, title, lang, article]);
  const on = manual ?? (!!cfg?.auto && foreign);
  const state = useTranslation(() => article.current?.blockTexts(lang) || [], { key: `${id}\n${html}`, title, enabled: on, lang });
  const shown = useMemo(() => (on ? { map: state.map, display, lang } : null), [on, state.map, display, lang]);
  return { ...state, on, foreign, lang, display, shown, toggle: () => setManual(!on) };
}
