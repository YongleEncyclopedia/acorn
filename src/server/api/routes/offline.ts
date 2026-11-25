/**
 * The offline pack (离线包): which files of the web app a device stores so the reader opens without a connection.
 * The articles themselves come through the ordinary API: the device asks for them exactly as the reader will
 * (web/src/lib/offline.ts), and the service worker answers from what was stored (web/public/sw.js).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { App } from "../../app.ts";
import type { OfflineAssets } from "../../../shared/types.ts";

/** The reading fonts by the setting that shows them (web/src/fonts.ts); 黑体 uses the system's sans. */
const FONTS: Record<keyof OfflineAssets["fonts"], RegExp> = {
  serif: /^(noto-serif-sc|literata)-/,
  kai: /^lxgwwenkaiscreen-/,
};
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;
// what the page itself needs besides its code (the icons for the home screen come with the manifest when installed)
const TOP = ["/", "/manifest.webmanifest", "/icon.svg"];

const size = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

export function offlineAssets(webDir: string): OfflineAssets {
  const out: OfflineAssets = { app: [...TOP], fonts: { serif: [], kai: [] }, bytes: { app: 0, serif: 0, kai: 0 } };
  for (const u of TOP) out.bytes.app += size(path.join(webDir, u === "/" ? "index.html" : u));
  const dir = path.join(webDir, "assets");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const url = `/assets/${name}`;
    const bytes = size(path.join(dir, name));
    if (!FONT_FILE.test(name)) {
      out.app.push(url);
      out.bytes.app += bytes;
      continue;
    }
    // a font of no reading setting (none today) loads when a page needs it, as before
    for (const k of Object.keys(FONTS) as (keyof OfflineAssets["fonts"])[]) {
      if (!FONTS[k].test(name)) continue;
      out.fonts[k].push(url);
      out.bytes[k] += bytes;
    }
  }
  return out;
}

export function registerOffline(r: Hono, app: App): void {
  r.get("/api/offline/assets", (c) => c.json(offlineAssets(app.cfg.webDir)));
}
