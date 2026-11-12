// Render the Android launcher icon from web/public/icon.svg. From the project root, after `npm install`:
//   node android/icons/make-icons.mjs
//
// An adaptive icon is two 108 dp layers the launcher crops to its own shape (circle, squircle…), showing the
// middle 72 dp. The background layer is app/src/main/res/drawable/ic_launcher_background.xml, the same gradient
// as the SVG's rounded square; this script draws the foreground (the acorn on its own, the SVG's 512 units mapped
// onto those 72 dp, so everything stays inside the 66 dp circle every launcher shows) and the monochrome layer
// Android 13+ tints for themed icons.
import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const res = path.resolve(here, "../app/src/main/res");
const svg = readFileSync(path.resolve(here, "../../web/public/icon.svg"), "utf8");

// the artwork without the rounded square it sits on
const artwork = svg.replace(/<rect width="512" height="512"[^>]*\/>/, "");
if (artwork === svg) throw new Error("icon.svg changed shape: the full-size background <rect> was not found");

// One colour; the cap's lattice, the line on the nut and thin gaps around the band and the seal are cut out.
const monochrome = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <clipPath id="cap"><path d="M132 238c0-74 56-124 124-124s124 50 124 124z"/></clipPath>
    <mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="#fff"/>
      <g clip-path="url(#cap)" stroke="#000" stroke-width="9">
        <path d="M100 150l200 200M140 110l200 200M180 70l200 200M60 190l200 200M220 30l200 200"/>
        <path d="M412 150L212 350M372 110L172 310M332 70L132 270M452 190L252 390M292 30L92 230"/>
      </g>
      <rect x="118" y="226" width="276" height="34" rx="17" fill="#000" stroke="#000" stroke-width="12"/>
      <path d="M196 292c4 46 22 82 46 104" fill="none" stroke="#000" stroke-width="14" stroke-linecap="round"/>
      <rect x="322" y="348" width="86" height="86" rx="16" fill="#000" transform="rotate(-8 365 391)"/>
    </mask>
  </defs>
  <g mask="url(#cut)">
    <path d="M256 118c-4-26 6-48 30-62" fill="none" stroke="#000" stroke-width="20" stroke-linecap="round"/>
    <path d="M132 238c0-74 56-124 124-124s124 50 124 124z"/>
    <path d="M154 260c0 94 50 156 102 172 52-16 102-78 102-172z"/>
  </g>
  <rect x="118" y="226" width="276" height="34" rx="17"/>
  <g transform="rotate(-8 365 391)">
    <rect x="330" y="356" width="70" height="70" rx="12" fill="none" stroke="#000" stroke-width="7"/>
    <text x="365" y="408" font-family="Kaiti SC, STKaiti, KaiTi, serif" font-size="46" font-weight="700" text-anchor="middle">藏</text>
  </g>
</svg>`;

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const clear = { r: 0, g: 0, b: 0, alpha: 0 };

async function layer(source, scale) {
  const canvas = Math.round(108 * scale);
  const size = Math.round(72 * scale);
  const margin = (canvas - size) / 2;
  // rendered at twice the size and scaled down, for smoother edges
  const art = await sharp(Buffer.from(source), { density: 72 * (size / 512) * 2 })
    .resize(size, size)
    .png()
    .toBuffer();
  return sharp(art).extend({ top: margin, bottom: margin, left: margin, right: margin, background: clear }).png({ compressionLevel: 9 });
}

for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = path.join(res, `mipmap-${name}`);
  mkdirSync(dir, { recursive: true });
  await (await layer(artwork, scale)).toFile(path.join(dir, "ic_launcher_foreground.png"));
  await (await layer(monochrome, scale)).toFile(path.join(dir, "ic_launcher_monochrome.png"));
}
// the setup screen shows the whole icon, rounded square included
mkdirSync(path.join(res, "drawable-nodpi"), { recursive: true });
await sharp(Buffer.from(svg), { density: 72 * (288 / 512) * 2 })
  .resize(288, 288)
  .png({ compressionLevel: 9 })
  .toFile(path.join(res, "drawable-nodpi", "acorn_icon.png"));

console.log("android icons written to", res);
