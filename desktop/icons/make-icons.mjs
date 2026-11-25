// Render the desktop app's icons from web/public/icon.svg (run: npm run icons, in desktop/).
//   icon-mac.png  1024: the artwork inside macOS's icon grid (824 px body, soft shadow), for the .icns
//   icon.png      1024: the artwork edge to edge, for Windows (.ico), Linux and the window itself
//   tray.png        64: for the tray on Windows and Linux
import sharp from "sharp";
import { readFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const svg = readFileSync(path.resolve(here, "../../web/public/icon.svg"));
const art = (size) => sharp(svg, { density: 72 * (size / 512) * 2 }).resize(size, size).png().toBuffer();

await sharp(await art(1024)).toFile(path.join(here, "icon.png"));
await sharp(await art(64)).toFile(path.join(here, "tray.png"));

// macOS draws no mask of its own: the icon brings its rounded body, margins and shadow.
const BODY = 824;
const MARGIN = (1024 - BODY) / 2;
const shadow = await sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect x="${MARGIN}" y="${MARGIN + 12}" width="${BODY}" height="${BODY}" rx="${BODY * 0.2237}" fill="#000" fill-opacity=".28"/>
  </svg>`),
)
  .blur(18)
  .png()
  .toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([
    { input: shadow, top: 0, left: 0 },
    { input: await art(BODY), top: MARGIN, left: MARGIN },
  ])
  .png()
  .toFile(path.join(here, "icon-mac.png"));

console.log("desktop icons written to", here);
