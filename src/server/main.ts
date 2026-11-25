import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { loadConfig, VERSION } from "./config.ts";
import { createApp, ensureCliToken } from "./app.ts";
import { createHttp } from "./api/http.ts";
import { startScheduler, type Scheduler } from "./scheduler.ts";
import { hasPassword, setPassword } from "./api/auth.ts";
import { holdLock, lockHolder } from "./lock.ts";
import { logger } from "./util/log.ts";

const log = logger("acorn");
const cfg = loadConfig();

// One library, one server (see lock.ts): leave the data alone if another Acorn already has it open.
const holder = await lockHolder(cfg.dataDir);
if (holder) {
  log.error(`这个数据目录正被另一个松果使用（进程 ${holder.pid}，http://localhost:${holder.port}）。同一份数据只能由一个松果打开：${cfg.dataDir}`);
  process.exit(3);
}

const app = createApp(cfg);
let release = () => {};

// ACORN_PASSWORD only sets the first password; changing it later happens in the app or with `acorn passwd`.
if (cfg.initialPassword && !app.settings.getRaw("_password")) {
  setPassword(app, cfg.initialPassword);
  log.info("password set from ACORN_PASSWORD");
}
ensureCliToken(app);

let scheduler: Scheduler | null = null;
const http = createHttp(app, {
  onSettingsChanged: () => {
    scheduler?.rescheduleDigest();
    scheduler?.rescheduleBackup();
  },
});
const server = serve({ fetch: http.fetch, port: cfg.port, hostname: cfg.host }, () => {
  release = holdLock(cfg.dataDir, cfg.port);
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i!.address}:${cfg.port}`);
  log.info(`Acorn 松果 ${VERSION} 已启动`);
  log.info(`本机   http://localhost:${cfg.port}`);
  for (const u of lan) log.info(`局域网 ${u}`);
  log.info(`数据   ${cfg.dataDir}`);
  if (!hasPassword(app)) log.info("第一次使用：在本机浏览器打开上面的地址设置密码");
});
server.on("error", (err: NodeJS.ErrnoException) => {
  log.error(err.code === "EADDRINUSE" ? `端口 ${cfg.port} 已被占用。换一个端口（ACORN_PORT），或先关掉占用它的程序。` : `无法启动：${err.message}`);
  process.exit(1);
});

if (cfg.scheduler) scheduler = startScheduler(app);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  log.info(`收到 ${signal}，正在退出`);
  scheduler?.stop();
  const finish = () => {
    try {
      app.db.close();
    } catch {
      /* already closed */
    }
    release();
    process.exit(0);
  };
  server.close(finish);
  // Long-lived connections (the SSE event stream) would otherwise keep the server open.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  setTimeout(finish, 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Inside the desktop app this is a child process without a terminal, and the app asks it to stop with a message:
// a signal is not a polite request on Windows.
(process as unknown as { parentPort?: { on(event: "message", fn: (e: { data: unknown }) => void): void } }).parentPort?.on("message", (e) => {
  if (e.data === "shutdown") shutdown("shutdown");
});
