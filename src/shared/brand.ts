/**
 * Acorn's mark: one acorn, drawn on a 100 × 100 grid and centred on x = 50. Every rendition — the logo in the
 * web app, the PWA and desktop icons, the README artwork — is built from these paths, so they cannot drift apart.
 *
 * Construction: the cup is half an ellipse (28 × 20) on a rim with 2.6-unit corners; the gap under it is as wide
 * as the stem is thick; the nut tapers in one curve to a softened tip; a single highlight on the nut is cut out
 * of it. The glyph's box is 22–78 × 13–88, set a little above the grid's centre where it looks centred.
 * Kept free of imports: Node (scripts) and the browser both load it.
 */

export const ACORN = {
  cup: "M22,44 A28,20 0 0 1 78,44 L78,45.9 Q78,48.5 75.4,48.5 L24.6,48.5 Q22,48.5 22,45.9 Z",
  nut: "M31.7,53.1 L68.3,53.1 Q71.5,53.1 71.5,56.3 C71.5,70.6 62.47,82.3 51.5,87 Q50,87.65 48.5,87 C37.53,82.3 28.5,70.6 28.5,56.3 Q28.5,53.1 31.7,53.1 Z",
  /** Drawn as a stroke, 5.2 wide with round ends. */
  stem: "M50.6,24.6 C50.6,18.6 53,15.2 57.8,13.1",
  stemWidth: 5.2,
  /** Cut out of the nut: a stroke 2.7 wide with round ends. */
  highlight: "M35.1,59.9 C35.5,68.7 38.9,75.7 44.3,80.3",
  highlightWidth: 2.7,
} as const;

/** The icon's colours: a vermilion that runs a little deeper towards the bottom, and the glyph in white. */
export const BRAND = {
  top: "#D9492F",
  bottom: "#B23226",
  /** For text and flat fills where a gradient does not belong. */
  red: "#C23A2B",
  glyph: "#FFFFFF",
} as const;

/**
 * The glyph as SVG markup. `id` keeps the cut-out's mask unique when several are on one page.
 * `color` fills it; the highlight is a real hole, so whatever is behind shows through.
 */
export function glyphSvg({ color = "currentColor", id = "acorn" }: { color?: string; id?: string } = {}): string {
  return (
    `<mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
    `<rect width="100" height="100" fill="#fff"/>` +
    `<path d="${ACORN.highlight}" fill="none" stroke="#000" stroke-width="${ACORN.highlightWidth}" stroke-linecap="round"/></mask>` +
    `<g fill="${color}"><path d="${ACORN.cup}"/><path d="${ACORN.nut}" mask="url(#${id}-cut)"/></g>` +
    `<path d="${ACORN.stem}" fill="none" stroke="${color}" stroke-width="${ACORN.stemWidth}" stroke-linecap="round"/>`
  );
}

/**
 * A rounded square with continuous corners, the way iOS and macOS draw app icons: the edges stay straight and
 * each corner eases in through a Bézier ramp, a circular arc and the mirrored ramp, so its curvature never
 * jumps. This is the construction behind Figma's "corner smoothing" (here 60%, close to Apple's); r = 22.37% of
 * the side is the radius Apple uses for icons.
 */
export function squirclePath(size = 100, r = size * 0.2237, smoothing = 0.6): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const p = Math.min((1 + smoothing) * r, size / 2);
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const beta = 45 * smoothing;
  const c = r * Math.tan(rad(alpha / 2)) * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const n = (v: number) => +v.toFixed(3);
  const [A, AB, ABC, C, D, BC, ARC] = [a, a + b, a + b + c, c, d, b + c, arc].map(n);
  const R = n(r);
  return [
    `M${n(size - p)},0`,
    `c${A},0 ${AB},0 ${ABC},${D}`,
    `a${R},${R} 0 0 1 ${ARC},${ARC}`,
    `c${D},${C} ${D},${BC} ${D},${ABC}`,
    `L${size},${n(size - p)}`,
    `c0,${A} 0,${AB} ${-D},${ABC}`,
    `a${R},${R} 0 0 1 ${-ARC},${ARC}`,
    `c${-C},${D} ${-BC},${D} ${-ABC},${D}`,
    `L${n(p)},${size}`,
    `c${-A},0 ${-AB},0 ${-ABC},${-D}`,
    `a${R},${R} 0 0 1 ${-ARC},${-ARC}`,
    `c${-D},${-C} ${-D},${-BC} ${-D},${-ABC}`,
    `L0,${n(p)}`,
    `c0,${-A} 0,${-AB} ${D},${-ABC}`,
    `a${R},${R} 0 0 1 ${ARC},${-ARC}`,
    `c${C},${-D} ${BC},${-D} ${ABC},${-D}`,
    "Z",
  ].join(" ");
}

/**
 * The app icon as a complete SVG document. shape: "squircle" for where the icon is shown as it is (favicon,
 * the README), "square" where the platform cuts its own shape (iOS home screen, Android adaptive icons).
 * `scale` is the glyph's size relative to the icon: 0.84 fills it the way Apple's icons do; maskable icons
 * need it inside a circle of 80% and use about 0.66.
 */
export function iconSvg({ shape = "squircle", size = 512, scale = 0.84, shadow = true }: { shape?: "squircle" | "square"; size?: number; scale?: number; shadow?: boolean } = {}): string {
  const offset = 50 - 50 * scale;
  const body = shape === "square" ? `<rect width="100" height="100" fill="url(#bg)"/>` : `<path d="${squirclePath()}" fill="url(#bg)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.top}"/><stop offset="1" stop-color="${BRAND.bottom}"/></linearGradient>` +
    (shadow ? `<filter id="lift" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.1" stdDeviation="1.3" flood-color="#5A130B" flood-opacity=".24"/></filter>` : "") +
    `</defs>${body}` +
    `<g${shadow ? ' filter="url(#lift)"' : ""} transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale})">${glyphSvg({ color: BRAND.glyph, id: "icon" })}</g>` +
    `</svg>`
  );
}
