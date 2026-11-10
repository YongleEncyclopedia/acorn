import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const backend = process.env.ACORN_DEV_BACKEND || "http://127.0.0.1:7700";

/**
 * Every browser that can run the app (es2022) reads WOFF2. The WOFF fallbacks in @fontsource's stylesheets were
 * never requested; they only doubled the font files in dist/ and padded the stylesheet.
 */
function woff2Only(): Plugin {
  return {
    name: "acorn-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/@fontsource") || !/\.css(\?|$)/.test(id)) return null;
      return { code: code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, ""), map: null };
    },
  };
}

/**
 * The font stylesheet is requested by the script after it starts (web/src/fonts.ts). A preload hint lets the
 * browser fetch it alongside the script instead of after it, without making it block rendering.
 */
function preloadFontStyles(): Plugin {
  return {
    name: "acorn-preload-font-styles",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const css = Object.keys(ctx.bundle || {}).find((file) => /(^|\/)fonts-[^/]+\.css$/.test(file));
        // `crossorigin` matches how Vite's loader requests it; without it the preloaded copy would not be reused.
        return css ? [{ tag: "link", attrs: { rel: "preload", as: "style", href: `/${css}`, crossorigin: true }, injectTo: "head" }] : [];
      },
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [woff2Only(), react(), preloadFontStyles()],
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/web"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/files", "/reader", "/accounts"].map((p) => [p, { target: backend, changeOrigin: false }])),
  },
});
