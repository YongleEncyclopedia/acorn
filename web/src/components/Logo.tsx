import { useId } from "react";
import { ACORN, BRAND, squirclePath } from "../../../src/shared/brand.ts";

const SQUIRCLE = squirclePath();

/** The acorn alone, in the current text colour. Its highlight is cut out, so it works on any background. */
export function Glyph({ size = 24, className = "" }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg className={`glyph ${className}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <mask id={`${id}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="#fff" />
        <path d={ACORN.highlight} fill="none" stroke="#000" strokeWidth={ACORN.highlightWidth} strokeLinecap="round" />
      </mask>
      <g fill="currentColor">
        <path d={ACORN.cup} />
        <path d={ACORN.nut} mask={`url(#${id}-cut)`} />
      </g>
      <path d={ACORN.stem} fill="none" stroke="currentColor" strokeWidth={ACORN.stemWidth} strokeLinecap="round" />
    </svg>
  );
}

/** The app icon: the acorn in white on its vermilion square with continuous corners. */
export function AppIcon({ size = 24, className = "" }: { size?: number; className?: string }) {
  const id = useId();
  // below ~28 px the glyph's own shadow is only a smudge
  const lift = size >= 28;
  return (
    <svg className={`app-icon ${className}`} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="松果">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BRAND.top} />
          <stop offset="1" stopColor={BRAND.bottom} />
        </linearGradient>
        {lift && (
          <filter id={`${id}-lift`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.1" stdDeviation="1.3" floodColor="#5A130B" floodOpacity="0.24" />
          </filter>
        )}
        <mask id={`${id}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <path d={ACORN.highlight} fill="none" stroke="#000" strokeWidth={ACORN.highlightWidth} strokeLinecap="round" />
        </mask>
      </defs>
      <path d={SQUIRCLE} fill={`url(#${id}-bg)`} />
      <g filter={lift ? `url(#${id}-lift)` : undefined} transform="translate(8 8) scale(0.84)" fill={BRAND.glyph}>
        <path d={ACORN.cup} />
        <path d={ACORN.nut} mask={`url(#${id}-cut)`} />
        <path d={ACORN.stem} fill="none" stroke={BRAND.glyph} strokeWidth={ACORN.stemWidth} strokeLinecap="round" />
      </g>
    </svg>
  );
}
