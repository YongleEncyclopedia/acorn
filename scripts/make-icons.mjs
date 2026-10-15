// Render PWA icons from web/public/icon.svg (run: npm run icons).
import sharp from "sharp";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../web/public");
const svg = readFileSync(path.join(dir, "icon.svg"));
for (const size of [180, 192, 512]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(path.join(dir, `icon-${size}.png`));
}
// Maskable: full-bleed background with the glyph inside the 80% safe zone.
const inner = await sharp(svg, { density: 384 }).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#7d5129" } })
  .composite([{ input: inner, top: 56, left: 56 }])
  .png()
  .toFile(path.join(dir, "icon-maskable-512.png"));
console.log("icons written to", dir);
