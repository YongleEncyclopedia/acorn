/**
 * Preview of the web app with a note-taking overlay (标注) for UI feedback; dev only (see README.md here).
 * The overlay script is injected into the page; notes are kept in tools/ui-notes/notes.json (not committed) for
 * the agent to read.
 *
 *   ACORN_DEV_BACKEND=http://127.0.0.1:7716 npx vite --config tools/ui-notes/vite.notes.config.ts --port 5174
 */
import { defineConfig, mergeConfig, type Plugin } from "vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import base from "../../web/vite.config.ts";

const dir = import.meta.dirname;
const file = path.join(dir, "notes.json");
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);

function notes(): Plugin {
  return {
    name: "acorn-ui-notes",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "script", attrs: { src: "/__notes/overlay.js", defer: true }, injectTo: "body" }],
    configureServer(server) {
      server.middlewares.use("/__notes", (req, res) => {
        const send = (status: number, body: unknown, type = "application/json") => {
          res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        if (req.method === "GET" && req.url?.startsWith("/overlay.js")) return send(200, readFileSync(path.join(dir, "overlay.js"), "utf8"), "text/javascript");
        if (req.method === "GET") return send(200, read());
        if (req.method === "PUT") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const list = JSON.parse(body);
              if (!Array.isArray(list)) throw new Error("expected a list");
              writeFileSync(file, JSON.stringify(list, null, 2));
              send(200, { ok: true, count: list.length });
            } catch (e) {
              send(400, { error: (e as Error).message });
            }
          });
          return;
        }
        send(405, { error: "method" });
      });
    },
  };
}

export default mergeConfig(base, defineConfig({ plugins: [notes()], server: { strictPort: true } }));
