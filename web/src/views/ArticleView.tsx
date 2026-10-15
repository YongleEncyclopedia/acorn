import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Copy, MessageSquarePlus, Trash2 } from "lucide-react";
import { api } from "../lib/api.ts";
import { clearHighlights, flashHighlight, renderHighlights, selectorFromRange } from "../lib/highlight.ts";
import { applyTranslation, blockTexts, type ShownTranslation } from "../lib/translate.ts";
import { TR_ATTR } from "../../../src/shared/translate.ts";
import { toast, toastError, ui } from "../lib/store.ts";
import { Popover } from "../components/Popover.tsx";
import type { Highlight, HighlightColor, ReaderPrefs } from "../../../src/shared/types.ts";

const COLORS: HighlightColor[] = ["amber", "green", "blue", "rose", "violet"];
const COLOR_LABEL: Record<HighlightColor, string> = { amber: "黄", green: "绿", blue: "蓝", rose: "红", violet: "紫" };
const IFRAME_HOSTS = /^(https:)?\/\/(www\.)?(youtube(-nocookie)?\.com|player\.bilibili\.com|player\.vimeo\.com|open\.spotify\.com|embed\.music\.apple\.com|w\.soundcloud\.com|music\.163\.com)\//;

let hooked = false;
function purify(html: string): string {
  if (!hooked) {
    DOMPurify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "iframe") {
        const src = (node as Element).getAttribute("src") || "";
        if (!IFRAME_HOSTS.test(src)) node.parentNode?.removeChild(node);
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html, { ADD_TAGS: ["iframe"], ADD_ATTR: ["allowfullscreen", "frameborder", "loading"], FORBID_ATTR: ["style"] });
}

export interface ArticleHandle {
  el: HTMLElement | null;
  flash: (id: number) => void;
  /** Texts of the blocks that need translating into `lang`. */
  blockTexts: (lang: string) => string[];
}

interface Props {
  html: string;
  highlights: Highlight[];
  target: { entryId?: number | null; archiveId?: number | null };
  prefs: ReaderPrefs;
  translation?: ShownTranslation | null;
  onChanged: () => void;
}

export const ArticleView = forwardRef<ArticleHandle, Props>(function ArticleView({ html, highlights, target, prefs, translation, onChanged }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ rect: DOMRect; range: Range } | null>(null);
  const [editing, setEditing] = useState<{ id: number; anchor: HTMLElement; focusNote?: boolean } | null>(null);
  const local = useRef<Highlight[]>(highlights);
  local.current = highlights;
  const shown = useRef(translation);
  shown.current = translation;

  useImperativeHandle(
    ref,
    () => ({
      el: el.current,
      flash: (id) => el.current && flashHighlight(el.current, id),
      blockTexts: (lang) => (el.current ? blockTexts(el.current, lang) : []),
    }),
    [],
  );

  // Inject sanitized HTML (manually, so highlight marks are not clobbered by React).
  useLayoutEffect(() => {
    const root = el.current;
    if (!root) return;
    root.innerHTML = purify(html);
    for (const a of root.querySelectorAll("a[href]")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
    for (const img of root.querySelectorAll("img")) {
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      img.addEventListener("error", () => img.classList.add("broken"), { once: true });
    }
    for (const f of root.querySelectorAll("iframe")) f.setAttribute("loading", "lazy");
    applyTranslation(root, shown.current);
    renderHighlights(root, local.current);
  }, [html]);

  useLayoutEffect(() => {
    const root = el.current;
    if (!root) return;
    applyTranslation(root, translation);
    renderHighlights(root, local.current);
  }, [translation]);

  useEffect(() => {
    if (el.current) renderHighlights(el.current, highlights);
  }, [highlights]);

  // Selection toolbar
  useEffect(() => {
    const onUp = () => {
      window.setTimeout(() => {
        const s = window.getSelection();
        if (!s || s.isCollapsed || !s.rangeCount || !el.current) return setSel(null);
        const range = s.getRangeAt(0);
        if (!el.current.contains(range.commonAncestorContainer)) return setSel(null);
        if (!range.toString().trim()) return setSel(null);
        setSel({ rect: range.getBoundingClientRect(), range: range.cloneRange() });
      }, 10);
    };
    const onChange = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    };
    document.addEventListener("pointerup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const onClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const mark = t.closest("mark.acorn-hl") as HTMLElement | null;
    if (mark && !window.getSelection()?.toString()) {
      setEditing({ id: Number(mark.dataset.id), anchor: mark });
      return;
    }
    if (t.tagName === "IMG" && !t.closest("a")) {
      ui.set({ lightbox: (t as HTMLImageElement).currentSrc || (t as HTMLImageElement).src });
    }
  }, []);

  const create = async (color: HighlightColor, withNote = false) => {
    if (!sel || !el.current) return;
    const selector = selectorFromRange(el.current, sel.range);
    window.getSelection()?.removeAllRanges();
    setSel(null);
    if (!selector) {
      if (sel.range.startContainer.parentElement?.closest(`[${TR_ATTR}]`)) toast("译文不能划线，请选原文");
      return;
    }
    try {
      const h = await api.createHighlight({ ...target, ...selector, color });
      onChanged();
      if (withNote) {
        window.setTimeout(() => {
          const mark = el.current?.querySelector<HTMLElement>(`mark.acorn-hl[data-id="${h.id}"]`);
          if (mark) setEditing({ id: h.id, anchor: mark, focusNote: true });
        }, 120);
      }
    } catch (err) {
      toastError(err);
    }
  };

  const copySel = async () => {
    const text = sel?.range.toString() || "";
    window.getSelection()?.removeAllRanges();
    setSel(null);
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    toast("已复制");
  };

  const barPos = sel
    ? (() => {
        const top = sel.rect.top > 72 ? sel.rect.top - 50 : sel.rect.bottom + 10;
        return { top, left: Math.min(Math.max(sel.rect.left + sel.rect.width / 2, 150), window.innerWidth - 150) };
      })()
    : null;

  return (
    <>
      <div ref={el} className="article" data-justify={prefs.justify} data-indent={prefs.indent} onClick={onClick} />
      {sel && barPos && (
        <div className="sel-bar" style={barPos} onPointerDown={(e) => e.preventDefault()}>
          {COLORS.map((c) => (
            <button key={c} onClick={() => create(c)} title={`${COLOR_LABEL[c]}色高亮`} aria-label={`${COLOR_LABEL[c]}色高亮`}>
              <span className="dot" style={{ background: `var(--hl-${c}-solid)` }} />
            </button>
          ))}
          <span className="sep" />
          <button onClick={() => create("amber", true)}>
            <MessageSquarePlus size={16} />
            批注
          </button>
          <button onClick={copySel} aria-label="复制">
            <Copy size={15} />
          </button>
        </div>
      )}
      {editing && (
        <HighlightEditor
          key={editing.id}
          highlight={highlights.find((h) => h.id === editing.id)}
          anchor={editing.anchor}
          focusNote={editing.focusNote}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
          onDeleted={() => {
            if (el.current) clearHighlights(el.current);
            onChanged();
          }}
        />
      )}
    </>
  );
});

function HighlightEditor({
  highlight,
  anchor,
  focusNote,
  onClose,
  onChanged,
  onDeleted,
}: {
  highlight: Highlight | undefined;
  anchor: HTMLElement;
  focusNote?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [note, setNote] = useState(highlight?.note || "");
  const [color, setColor] = useState<HighlightColor>(highlight?.color || "amber");
  const saved = useRef(highlight?.note || "");
  if (!highlight) return null;
  const save = async () => {
    if (note === saved.current) return;
    saved.current = note;
    try {
      await api.patchHighlight(highlight.id, { note: note.trim() || null });
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const close = () => {
    void save();
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={close} placement="bottom" className="hl-pop">
      <blockquote>{highlight.quote}</blockquote>
      <textarea
        className="field"
        placeholder="写下你的想法…"
        value={note}
        autoFocus={focusNote}
        rows={3}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) close();
        }}
      />
      <div className="colors">
        {COLORS.map((c) => (
          <button
            key={c}
            aria-pressed={c === color}
            aria-label={`${COLOR_LABEL[c]}色`}
            style={{ background: `var(--hl-${c}-solid)` }}
            onClick={async () => {
              setColor(c);
              await api.patchHighlight(highlight.id, { color: c }).catch(toastError);
              onChanged();
            }}
          />
        ))}
        <span className="grow" />
        <button
          className="icon-btn sm"
          title="复制引文"
          onClick={async () => {
            await navigator.clipboard?.writeText(`> ${highlight.quote}${note ? `\n\n${note}` : ""}`).catch(() => undefined);
            toast("已复制");
          }}
        >
          <Copy size={15} />
        </button>
        <button
          className="icon-btn sm"
          title="删除高亮"
          style={{ color: "var(--danger)" }}
          onClick={async () => {
            await api.deleteHighlight(highlight.id).catch(toastError);
            onClose();
            onDeleted();
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </Popover>
  );
}
