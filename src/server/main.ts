import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { loadConfig, VERSION } from "./config.ts";
import { createApp, ensureCliToken } from "./app.ts";
import { createHttp } from "./api/http.ts";
import { startScheduler, type Scheduler } from "./scheduler.ts";
import { hasPassword, setPassword } from "./api/auth.ts";
import { logger } from "./util/log.ts";

const log = logger("acorn");
const cfg = loadConfig();
const app = createApp(cfg);

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
    process.exit(0);
  };
  server.close(finish);
  // Long-lived connections (the SSE event stream) would otherwise keep the server open.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  setTimeout(finish, 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
