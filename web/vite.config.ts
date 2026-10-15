import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const backend = process.env.ACORN_DEV_BACKEND || "http://127.0.0.1:7700";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist/web"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/files", "/reader", "/accounts"].map((p) => [p, { target: backend, changeOrigin: false }])),
  },
});
