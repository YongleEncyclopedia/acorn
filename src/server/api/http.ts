import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import type { App } from "../app.ts";
import { registerCore, type Hooks } from "./routes/core.ts";
import { registerFeeds } from "./routes/feeds.ts";
import { registerEntries } from "./routes/entries.ts";
import { registerArchives } from "./routes/archives.ts";
import { registerTranslate } from "./routes/translate.ts";
import { registerGReader } from "./greader.ts";
import { registerOutputs } from "./outputs.ts";
import { SourceChoiceError } from "../feeds/add.ts";
import { HttpError } from "../util/http.ts";
import { NotAFeedError } from "../feeds/parse.ts";
import { BlockedError } from "../archive/capture.ts";
import { BrowserBlockedError } from "../archive/browser.ts";
import { clearSession, hasPassword, isAuthenticated, isLoopback, issueSession, loginAllowed, setPassword, verifyPassword } from "./auth.ts";
import { logger } from "../util/log.ts";

const log = logger("http");

const PUBLIC_API = new Set(["/api/session", "/api/login", "/api/setup", "/api/logout", "/api/greader/accounts/ClientLogin", "/api/health"]);

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' https: http: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.bilibili.com https://player.vimeo.com https://open.spotify.com https://embed.music.apple.com https://w.soundcloud.com https://music.163.com 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function createHttp(app: App, hooks: Hooks = {}): Hono {
  const r = new Hono();

  r.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "bad_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    if (err instanceof SourceChoiceError) return c.json({ error: "choose_source", message: err.message, preview: err.preview }, 409);
    if (err instanceof NotAFeedError) return c.json({ error: "not_a_feed", message: err.message }, 422);
    if (err instanceof BrowserBlockedError) return c.json({ error: "verify", message: err.message, spaceId: err.spaceId, url: err.url }, 423);
    if (err instanceof BlockedError) return c.json({ error: "blocked", message: err.message }, 423);
    if (err instanceof HttpError) return c.json({ error: "upstream", message: err.message, status: err.status }, 502);
    if (err instanceof SyntaxError) return c.json({ error: "bad_request", message: "请求格式不正确" }, 400);
    log.error(`${c.req.method} ${c.req.path}`, err);
    return c.json({ error: "server_error", message: err.message }, 500);
  });

  r.use("*", async (c, next) => {
    await next();
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    if (!c.res.headers.get("content-security-policy")) c.header("content-security-policy", APP_CSP);
    c.header("x-frame-options", "SAMEORIGIN");
  });

  // ---- session ----
  r.get("/api/session", (c) => c.json({ authenticated: isAuthenticated(app, c), setupRequired: !hasPassword(app), canSetup: !hasPassword(app) && isLoopback(c) }));
  r.post("/api/setup", async (c) => {
    if (hasPassword(app)) return c.json({ error: "forbidden", message: "已经设置过密码" }, 403);
    if (!isLoopback(c)) return c.json({ error: "forbidden", message: "第一次设置密码请在运行松果的这台电脑上打开" }, 403);
    const { password } = (await c.req.json()) as { password?: string };
    if (!password || password.length < 6) return c.json({ error: "bad_request", message: "密码至少 6 位" }, 400);
    setPassword(app, password);
    issueSession(app, c);
    return c.json({ ok: true });
  });
  r.post("/api/login", async (c) => {
    if (!loginAllowed(c)) return c.json({ error: "too_many", message: "尝试次数太多，请十分钟后再试" }, 429);
    const { password } = (await c.req.json()) as { password?: string };
    if (!password || !verifyPassword(password, app.settings.getRaw("_password"))) return c.json({ error: "forbidden", message: "密码不正确" }, 403);
    issueSession(app, c);
    return c.json({ ok: true });
  });
  r.post("/api/logout", (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });

  // ---- auth gate ----
  r.use("/api/*", async (c, next) => {
    if (PUBLIC_API.has(c.req.path) || isAuthenticated(app, c)) return next();
    return c.json({ error: "unauthorized", message: "请先登录" }, 401);
  });
  r.use("/files/*", async (c, next) => {
    if (isAuthenticated(app, c)) return next();
    return c.text("请先登录松果", 401);
  });

  registerCore(r, app, hooks);
  registerFeeds(r, app);
  registerEntries(r, app);
  registerArchives(r, app);
  registerTranslate(r, app);
  registerGReader(r, app);
  registerOutputs(r, app);

  r.get("/api/health", (c) => c.json({ ok: true }));
  r.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  // ---- web app (built by Vite into dist/web) ----
  const webDir = app.cfg.webDir;
  const rel = path.relative(process.cwd(), webDir) || ".";
  r.use(
    "/assets/*",
    serveStatic({
      root: rel,
      onFound: (_p, c) => {
        c.header("cache-control", "public, max-age=31536000, immutable");
      },
    }),
  );
  r.use(
    "*",
    serveStatic({
      root: rel,
      onFound: (p, c) => {
        if (/sw\.js$|index\.html$|manifest\.webmanifest$/.test(p)) c.header("cache-control", "no-cache");
      },
    }),
  );
  r.get("*", (c) => {
    const index = path.join(webDir, "index.html");
    if (!existsSync(index)) return c.text("网页界面还没有构建：请先运行 npm run build", 503);
    c.header("cache-control", "no-cache");
    return c.html(readFileSync(index, "utf8"));
  });
  return r;
}
