/** The 藏 seal: Acorn's mark for "kept forever on your disk". */
export function Seal({ size, stamp, title, char = "藏", muted }: { size?: "xs" | "sm" | "md"; stamp?: boolean; title?: string; char?: string; muted?: boolean }) {
  return (
    <span className={`seal ${size && size !== "md" ? size : ""} ${stamp ? "stamp" : ""} ${muted ? "muted" : ""}`} title={title} aria-label={title || "已入藏"} role="img">
      {char}
    </span>
  );
}
