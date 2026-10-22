import type { Hono } from "hono";
import { Readable } from "node:stream";
import type { App } from "../../app.ts";
import { exportStream } from "../../export.ts";

/** Taking the library away: all of it as one ZIP. */
export function registerData(r: Hono, app: App): void {
  r.get("/api/export", (c) => {
    const full = c.req.query("full") === "1";
    const name = `acorn-${full ? "full" : "markdown"}-${new Date().toISOString().slice(0, 10)}.zip`;
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename="${name}"`);
    c.header("cache-control", "no-store");
    return c.body(Readable.toWeb(exportStream(app, { full })) as ReadableStream);
  });

}
