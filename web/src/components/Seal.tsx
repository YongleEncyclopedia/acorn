/** The 藏 seal: Acorn's mark for "kept forever on your disk". */
export function Seal({ size, stamp, title, char = "藏", muted }: { size?: "xs" | "sm" | "md"; stamp?: boolean; title?: string; char?: string; muted?: boolean }) {
  return (
    <span className={`seal ${size && size !== "md" ? size : ""} ${stamp ? "stamp" : ""} ${muted ? "muted" : ""}`} title={title} aria-label={title || "已入藏"} role="img">
      {char}
    </span>
  );
}

/** Rough ink edge for seals (rendered once). */
export function SealDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id="seal-rough" x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" result="d" />
        <feComponentTransfer in="noise" result="speckle">
          <feFuncA type="discrete" tableValues="1 1 1 1 1 0.55 1 1" />
        </feComponentTransfer>
        <feComposite in="d" in2="speckle" operator="in" />
      </filter>
    </svg>
  );
}
