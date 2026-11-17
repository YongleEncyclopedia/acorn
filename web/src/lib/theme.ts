import type { ReaderPrefs } from "../../../src/shared/types.ts";

// the browser chrome around the app (the status bar on a phone) takes the colour of the top of the list pane
const THEME_BG: Record<string, string> = { paper: "#ffffff", sepia: "#f8f2e7", night: "#1c1c1e", ink: "#000000" };

export function resolveTheme(theme: ReaderPrefs["theme"]): "paper" | "sepia" | "night" | "ink" {
  if (theme !== "auto") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
}

export function applyTheme(theme: ReaderPrefs["theme"]): void {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute("content", THEME_BG[resolved]);
  try {
    localStorage.setItem("acorn.theme", theme);
  } catch {
    /* ignore */
  }
}

/** Apply the last theme before React renders to avoid a flash. */
export function bootTheme(): void {
  let t: ReaderPrefs["theme"] = "auto";
  try {
    t = (localStorage.getItem("acorn.theme") as ReaderPrefs["theme"]) || "auto";
  } catch {
    /* ignore */
  }
  applyTheme(t);
}

export const FONT_STACK: Record<ReaderPrefs["font"], string> = {
  serif: "var(--font-serif)",
  kai: "var(--font-kai)",
  sans: "var(--font-ui)",
};

export const WIDTH: Record<ReaderPrefs["width"], number> = { narrow: 32, medium: 38, wide: 46 };

export function readerStyle(p: ReaderPrefs): React.CSSProperties {
  return {
    ["--read-font" as string]: FONT_STACK[p.font],
    ["--read-size" as string]: `${p.fontSize}px`,
    ["--read-lh" as string]: String(p.lineHeight),
    ["--read-width" as string]: `${WIDTH[p.width] * p.fontSize}px`,
  };
}
