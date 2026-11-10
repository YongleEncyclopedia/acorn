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
