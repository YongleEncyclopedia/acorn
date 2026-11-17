// Render every icon from the mark in src/shared/brand.ts (run: npm run icons).
//   web/public/icon.svg              the favicon and the app icon wherever it is shown as it is
//   web/public/icon-32.png           favicon for browsers that do not take SVG
//   web/public/icon-180.png          iOS home screen (full square: iOS cuts its own corners)
//   web/public/icon-192/512.png      PWA, shown as they are
//   web/public/icon-maskable-512.png Android adaptive icon: full bleed, glyph inside the 80% safe circle
//   docs/brand/                      the same for the README and anyone writing about Acorn
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND, glyphSvg, iconSvg } from "../src/shared/brand.ts";

const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "web/public");
const brand = path.join(root, "docs/brand");
mkdirSync(brand, { recursive: true });

const png = (svg, size, file) => sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 100) * 1.0 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);

const squircle = iconSvg({ shape: "squircle", size: 512 });
writeFileSync(path.join(pub, "icon.svg"), squircle + "\n");
writeFileSync(path.join(brand, "icon.svg"), squircle + "\n");
writeFileSync(path.join(brand, "glyph.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">${glyphSvg({ color: BRAND.red, id: "glyph" })}</svg>\n`);

await png(iconSvg({ shape: "squircle", size: 32, shadow: false }), 32, path.join(pub, "icon-32.png"));
await png(iconSvg({ shape: "square", size: 180 }), 180, path.join(pub, "icon-180.png"));
await png(iconSvg({ shape: "squircle", size: 192 }), 192, path.join(pub, "icon-192.png"));
await png(iconSvg({ shape: "squircle", size: 512 }), 512, path.join(pub, "icon-512.png"));
await png(iconSvg({ shape: "square", size: 512, scale: 0.66 }), 512, path.join(pub, "icon-maskable-512.png"));
await png(iconSvg({ shape: "squircle", size: 1024 }), 1024, path.join(brand, "icon-1024.png"));
console.log("icons written to", path.relative(root, pub), "and", path.relative(root, brand));
