import { createPortal } from "react-dom";
import { ui } from "../lib/store.ts";

export function Toasts() {
  const toasts = ui.use((s) => s.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="act"
              onClick={() => {
                t.action!.run();
                ui.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function Lightbox() {
  const src = ui.use((s) => s.lightbox);
  if (!src) return null;
  return createPortal(
    <div className="lightbox" onClick={() => ui.set({ lightbox: null })} role="dialog" aria-label="查看图片">
      <img src={src} alt="" />
    </div>,
    document.body,
  );
}
