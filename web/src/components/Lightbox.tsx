import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X, ZoomIn, ZoomOut } from "lucide-react";
import { ui } from "../lib/store.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { useFocusTrap, useLayer } from "../lib/layers.ts";

/**
 * fit: the whole picture on screen. width: as wide as the screen, scrolled vertically — what long screenshots and
 * infographics need to be legible. full: every pixel, scrolled both ways.
 */
type Mode = "fit" | "width" | "full";

/** The article's pictures, one at a time: arrow keys or a swipe move between them, a click zooms. */
export function Lightbox() {
  const box = ui.use((s) => s.lightbox);
  return box ? <Viewer key={box.items.map((i) => i.src).join("|")} items={box.items} start={box.index} /> : null;
}

function Viewer({ items, start }: { items: { src: string; caption: string }[]; start: number }) {
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), items.length - 1));
  const [mode, setMode] = useState<Mode>("fit");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const item = items[index];
  const many = items.length > 1;
  const close = () => ui.set({ lightbox: null });
  const go = (d: number) => setIndex((i) => (i + d + items.length) % items.length);

  useLayer(close);
  useFocusTrap(root);
  // the page behind must not scroll under a finger that is dragging the picture
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useHotkeys({ ArrowLeft: () => many && go(-1), ArrowRight: () => many && go(1) }, true, { overlay: true });

  // A new picture starts fitted, until its size says it is a long one.
  useEffect(() => {
    setMode("fit");
    setSize(null);
    for (const d of [1, -1]) {
      const near = items[index + d];
      if (near) new Image().src = near.src;
    }
  }, [index, items]);

  useEffect(() => {
    stage.current?.scrollTo(0, 0);
  }, [mode, index]);

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setSize({ w, h });
    const el = stage.current;
    if (!el || !w || !h) return;
    // Fitted to the screen this picture would be a sliver: show it at reading width instead.
    const fitted = Math.min(el.clientWidth / w, el.clientHeight / h, 1) * w;
    if (h / w > 2.4 && fitted < Math.min(w, el.clientWidth) * 0.6) setMode("width");
  };

  const el = stage.current;
  const zoomable = !!size && !!el && (size.w > el.clientWidth * 1.05 || size.h > el.clientHeight * 1.05);
  const toggle = () => setMode((m) => (m === "fit" ? (zoomable ? "full" : "fit") : "fit"));

  return createPortal(
    <div ref={root} className="lightbox" role="dialog" aria-modal="true" aria-label="查看图片" tabIndex={-1}>
      <div className="lightbox-bar">
        {many && (
          <span className="count tabular">
            {index + 1} / {items.length}
          </span>
        )}
        <span className="grow" />
        {zoomable && (
          <button className="icon-btn" onClick={toggle} title={mode === "fit" ? "放大" : "适应屏幕"} aria-label={mode === "fit" ? "放大" : "适应屏幕"}>
            {mode === "fit" ? <ZoomIn size={19} /> : <ZoomOut size={19} />}
          </button>
        )}
        <a className="icon-btn" href={item.src} target="_blank" rel="noopener noreferrer" title="在新标签页打开" aria-label="在新标签页打开">
          <ExternalLink size={18} />
        </a>
        <button className="icon-btn" onClick={close} title="关闭（Esc）" aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      <div
        ref={stage}
        className="lightbox-stage"
        data-mode={mode}
        onClick={(e) => e.target === e.currentTarget && close()}
        onTouchStart={(e) => (swipe.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null)}
        onTouchEnd={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || mode !== "fit" || !many) return;
          const dx = e.changedTouches[0].clientX - s.x;
          const dy = e.changedTouches[0].clientY - s.y;
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        }}
      >
        <img
          key={item.src}
          src={item.src}
          alt={item.caption}
          onLoad={onLoad}
          onClick={toggle}
          style={mode === "full" && size ? { width: size.w } : mode === "width" && size ? { width: Math.min(size.w, el?.clientWidth || size.w) } : undefined}
          data-zoomable={zoomable || mode !== "fit"}
          draggable={false}
        />
      </div>
      {many && (
        <>
          <button className="lightbox-nav prev" onClick={() => go(-1)} aria-label="上一张">
            <ChevronLeft size={26} />
          </button>
          <button className="lightbox-nav next" onClick={() => go(1)} aria-label="下一张">
            <ChevronRight size={26} />
          </button>
        </>
      )}
      {item.caption && <div className="lightbox-caption">{item.caption}</div>}
    </div>,
    document.body,
  );
}
