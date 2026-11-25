import { Copy } from "lucide-react";
import { toast } from "../lib/store.ts";

export function copyText(text: string, msg = "已复制"): void {
  navigator.clipboard?.writeText(text).then(
    () => toast(msg),
    () => toast("没能复制，请手动选中复制", { kind: "error" }),
  );
}

/** An address to copy: one line, click to copy. */
export function CopyLine({ text, label }: { text: string; label?: string }) {
  return (
    <button type="button" className="code-line" onClick={() => copyText(text)} title="点击复制" aria-label={label ? `复制${label}` : "复制"} style={{ width: "100%", textAlign: "left" }}>
      <span>{text}</span>
      <Copy size={13} />
    </button>
  );
}
