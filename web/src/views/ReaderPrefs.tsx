import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlignJustify, IndentIncrease } from "lucide-react";
import { useBootstrap, keys } from "../lib/queries.ts";
import { api } from "../lib/api.ts";
import { applyTheme } from "../lib/theme.ts";
import { toastError } from "../lib/store.ts";
import { Segmented, Slider, Switch } from "../components/Controls.tsx";
import type { Bootstrap, ReaderPrefs } from "../../../src/shared/types.ts";
import { DEFAULT_PREFS } from "./defaults.ts";

/** Reader preferences live in server settings so every device reads the same way. */
export function usePrefs(): [ReaderPrefs, (patch: Partial<ReaderPrefs>) => void] {
  const { data } = useBootstrap();
  const qc = useQueryClient();
  const timer = useRef(0);
  const prefs = data?.settings.reader || DEFAULT_PREFS;
  const set = (patch: Partial<ReaderPrefs>) => {
    const next = { ...prefs, ...patch };
    qc.setQueryData<Bootstrap>(keys.bootstrap, (b) => (b ? { ...b, settings: { ...b.settings, reader: next } } : b));
    if (patch.theme) applyTheme(patch.theme);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.patchSettings({ reader: next }).catch(toastError);
    }, 400);
  };
  return [prefs, set];
}

const THEMES: { value: ReaderPrefs["theme"]; label: string; bg: string; fg: string }[] = [
  { value: "auto", label: "自动", bg: "linear-gradient(135deg, #f3efe7 50%, #141311 50%)", fg: "#8a5a2b" },
  { value: "paper", label: "纸", bg: "#f3efe7", fg: "#1f1b16" },
  { value: "sepia", label: "米", bg: "#ece2cf", fg: "#3a2e20" },
  { value: "night", label: "夜", bg: "#141311", fg: "#ebe5d8" },
  { value: "ink", label: "墨", bg: "#000", fg: "#e2e2e0" },
];

export function ThemePicker({ value, onChange }: { value: ReaderPrefs["theme"]; onChange: (v: ReaderPrefs["theme"]) => void }) {
  return (
    <div className="themes">
      {THEMES.map((t) => (
        <button key={t.value} aria-pressed={value === t.value} onClick={() => onChange(t.value)} style={{ background: t.bg, color: t.fg }} title={t.label}>
          {t.value === "auto" ? "" : t.label}
        </button>
      ))}
    </div>
  );
}

export function FontPicker({ value, onChange }: { value: ReaderPrefs["font"]; onChange: (v: ReaderPrefs["font"]) => void }) {
  return (
    <div className="fonts">
      <button aria-pressed={value === "serif"} onClick={() => onChange("serif")}>
        <b style={{ fontFamily: "var(--font-serif)" }}>永 Aa</b>宋体
      </button>
      <button aria-pressed={value === "kai"} onClick={() => onChange("kai")}>
        <b style={{ fontFamily: "var(--font-kai)" }}>永 Aa</b>文楷
      </button>
      <button aria-pressed={value === "sans"} onClick={() => onChange("sans")}>
        <b style={{ fontFamily: "var(--font-ui)" }}>永 Aa</b>黑体
      </button>
    </div>
  );
}

export function ReaderPrefsPanel() {
  const [p, set] = usePrefs();
  return (
    <div className="prefs">
      <ThemePicker value={p.theme} onChange={(theme) => set({ theme })} />
      <FontPicker value={p.font} onChange={(font) => set({ font })} />
      <div className="row">
        <span>字号</span>
        <Slider value={p.fontSize} min={14} max={26} step={1} onChange={(fontSize) => set({ fontSize })} label="字号" />
        <span className="tabular" style={{ width: 24, textAlign: "right" }}>
          {p.fontSize}
        </span>
      </div>
      <div className="row">
        <span>行距</span>
        <Slider value={p.lineHeight} min={1.4} max={2.3} step={0.05} onChange={(lineHeight) => set({ lineHeight })} label="行距" />
        <span className="tabular" style={{ width: 24, textAlign: "right" }}>
          {p.lineHeight.toFixed(1)}
        </span>
      </div>
      <div className="row">
        <span>版心</span>
        <Segmented
          value={p.width}
          onChange={(width) => set({ width })}
          options={[
            { value: "narrow", label: "窄" },
            { value: "medium", label: "适中" },
            { value: "wide", label: "宽" },
          ]}
        />
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span style={{ display: "flex", gap: 6, alignItems: "center", width: "auto" }}>
          <IndentIncrease size={15} /> 首行缩进
        </span>
        <Switch checked={p.indent} onChange={(indent) => set({ indent })} label="首行缩进" />
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span style={{ display: "flex", gap: 6, alignItems: "center", width: "auto" }}>
          <AlignJustify size={15} /> 两端对齐
        </span>
        <Switch checked={p.justify} onChange={(justify) => set({ justify })} label="两端对齐" />
      </div>
    </div>
  );
}
