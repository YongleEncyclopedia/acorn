import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import { egoAvailable } from "../../archive/browser.ts";
import { browserLogin, connect, waitingLogin } from "../../accounts/browser-login.ts";
import { describeService, getVia, normalizeOrigin, serviceById, SERVICES, type Service } from "../../accounts/services.ts";
import { accountFor, keepRenewed } from "../../accounts/use.ts";
import { LoginExpiredError } from "../../feeds/plugin-api.ts";
import { pluginChoices } from "../../feeds/plugins.ts";

const MANUAL = z.object({
  service: z.string(),
  origin: z.string().max(300).optional(),
  token: z.string().max(4000).optional(),
  cookie: z.string().max(16_000).optional(),
});
const BROWSER = z.object({ service: z.string(), origin: z.string().max(300).optional() });

const where = (s: Service, origin: string | undefined) => (s.originEditable ? normalizeOrigin(origin || "", s.origin) : s.origin);

/** 设置 → 账号: sign-ins to platforms. Nothing here ever answers with a token or cookie. */
export function registerAccounts(r: Hono, app: App): void {
  r.get("/api/accounts", async (c) => {
    const browser = await egoAvailable(app);
    return c.json({ services: SERVICES.map((s) => describeService(s, browser)), accounts: app.accounts.list() });
  });

  // by hand: a token or cookie the user copied from the platform
  r.post("/api/accounts", async (c) => {
    const body = MANUAL.parse(await c.req.json());
    const service = serviceById(body.service);
    if (!service) return c.json({ error: "not_found", message: "没有这个平台" }, 404);
    const value = (service.manual.kind === "token" ? body.token : body.cookie)?.trim();
    if (!value) return c.json({ error: "bad_request", message: `请填写${service.manual.label}` }, 400);
    const cred = service.fromManual ? service.fromManual(value) : service.manual.kind === "token" ? { token: value } : { cookie: value };
    const account = await connect(app, service, where(service, body.origin), cred);
    if (!account) return c.json({ error: "refused", message: `${service.name}不接受这个${service.manual.label}：请确认复制完整、没有过期` }, 422);
    return c.json({ account });
  });

  // in the user's browser: opens the platform there, and carries on once they say they signed in
  r.post("/api/accounts/browser", async (c) => {
    const body = BROWSER.parse(await c.req.json());
    const service = serviceById(body.service);
    if (!service) return c.json({ error: "not_found", message: "没有这个平台" }, 404);
    if (!service.login || !(await egoAvailable(app))) return c.json({ error: "unavailable", message: `这里不能用浏览器登录${service.name}，请按说明手动填写` }, 409);
    return c.json(await browserLogin(app, service, where(service, body.origin)));
  });
  r.post("/api/accounts/browser/:spaceId", async (c) => {
    const spaceId = Number(c.req.param("spaceId"));
    const w = waitingLogin(spaceId);
    const service = w && serviceById(w.service);
    if (!w || !service) return c.json({ error: "not_found", message: "没有找到这次登录，请重新点「用浏览器登录」" }, 404);
    return c.json(await browserLogin(app, service, w.origin, spaceId));
  });

  // does the platform still accept the sign-in?
  r.post("/api/accounts/:id/check", async (c) => {
    const id = Number(c.req.param("id"));
    const cred = app.accounts.credential(id);
    const service = cred && serviceById(cred.account.service);
    if (!cred || !service) return c.json({ error: "not_found", message: "没有这个账号" }, 404);
    try {
      const before = JSON.stringify(cred.jar);
      await service.whoami(cred, cred.account.origin, getVia(app));
      if (cred.jar && JSON.stringify(cred.jar) !== before) app.accounts.updateSecret(id, cred);
      app.accounts.setStatus(id, "ok");
    } catch (err) {
      if (!(err instanceof LoginExpiredError)) throw err;
      app.accounts.setStatus(id, "expired", `${err.message}，请重新登录`);
    }
    return c.json({ account: app.accounts.get(id) });
  });

  r.delete("/api/accounts/:id", (c) => {
    const ok = app.accounts.delete(Number(c.req.param("id")));
    return ok ? c.json({ ok }) : c.json({ error: "not_found", message: "没有这个账号" }, 404);
  });

  // a plugin parameter whose choices come from the account (the 星球 it joined…)
  r.get("/api/plugins/:id/choices", async (c) => {
    const id = c.req.param("id");
    const accountId = Number(c.req.query("account")) || undefined;
    const account = await accountFor(app, id, accountId);
    const before = JSON.stringify(account?.jar);
    try {
      const choices = await pluginChoices(app.cfg.pluginsDir, id, c.req.query("key") || "", app.cfg.pageUserAgent, account);
      keepRenewed(app, account, before);
      return c.json(choices);
    } catch (err) {
      if (err instanceof LoginExpiredError && account) app.accounts.setStatus(account.id, "expired", `${err.message}，请重新登录`);
      throw err;
    }
  });
}
