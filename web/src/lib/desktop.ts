import { useEffect } from "react";
import { useLocation } from "wouter";
import { api } from "./api.ts";
import { useFocusMode } from "./shell.ts";
import { toast, toastError, ui } from "./store.ts";

/**
 * The desktop app, when the reader runs inside its window (desktop/preload.cjs puts this bridge there). The
 * reader works the same without it; the app only adds a menu bar, whose items arrive here as commands.
 */
interface DesktopShell {
  platform: "darwin" | "win32" | "linux";
  /** One listener for the app's menu commands: "go:/settings", "add-source", "palette", "shortcuts", "focus", "refresh-all". */
  onCommand(listener: ((command: string) => void) | null): void;
}

export const desktop: DesktopShell | undefined = (window as unknown as { acornShell?: DesktopShell }).acornShell;

/**
 * Tell the stylesheets where the reader is running, before anything is painted: on macOS the app's window has
 * no title bar and the reader's top bars make room for the window buttons (app.css, `data-shell`).
 */
export function markShell(): void {
  if (desktop) document.documentElement.dataset.shell = desktop.platform === "darwin" ? "mac" : desktop.platform;
}

/** Carry out what the desktop app's menus ask for. */
export function useDesktopCommands(): void {
  const [, navigate] = useLocation();
  const [, toggleFocus] = useFocusMode();
  useEffect(() => {
    if (!desktop) return;
    desktop.onCommand((command) => {
      if (command.startsWith("go:")) {
        const target = command.slice(3);
        navigate(target);
        // a page that is already open does not scroll to a new #section by itself
        const hash = target.split("#")[1];
        if (hash) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ block: "start" }), 250);
      } else if (command === "add-source") ui.set({ addSource: {} });
      else if (command === "palette") ui.set({ palette: true });
      else if (command === "shortcuts") ui.set({ shortcuts: true });
      else if (command === "focus") toggleFocus();
      else if (command === "refresh-all") void api.refreshAll().then((r) => toast(r.queued ? `正在刷新 ${r.queued} 个订阅源` : "订阅源都在刷新中"), toastError);
    });
    return () => desktop.onCommand(null);
    // the listener reads nothing that changes between renders except the two stable functions above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
