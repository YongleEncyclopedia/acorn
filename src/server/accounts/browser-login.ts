/**
 * Signing in to a platform in the user's own browser (ego-browser): Acorn opens the platform's page there. If the
 * browser is signed in already, the sign-in is read from its cookies and checked at once; otherwise the page is
 * handed to the user (scan the QR code, type the password: captchas are theirs), and once they say they are done
 * the cookies are read again. Same hand-off pattern as captures behind a login wall (archive/browser.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import type { Account, BrowserLogin } from "../../shared/types.ts";
import { egoAvailable, runEgo } from "../archive/browser.ts";
import { LoginExpiredError } from "../feeds/plugin-api.ts";
import { queueRefresh } from "../feeds/refresh.ts";
import { getVia, type BrowserCookie, type Service } from "./services.ts";
import type { Credential } from "../store/accounts.ts";
import { logger } from "../util/log.ts";

const log = logger("accounts");

/** Sign-ins waiting for the user in a page Acorn opened, by ego-browser space id. */
const waiting = new Map<number, { service: string; origin: string; at: number }>();

interface LoginResult {
  ok: boolean;
  cookies?: BrowserCookie[];
  waiting?: boolean;
  spaceId?: number;
  error?: string;
}

/**
 * check: read the cookies; hand the page over when the sign-in is not there yet.
 * handoff: hand the page over regardless (the browser's sign-in was refused by the platform).
 */
function script(service: Service, origin: string, mode: "check" | "handoff", spaceId: number | null): string {
  const login = service.login!;
  return `
const SPACE = ${spaceId ?? "null"};
let task;
if (SPACE) { try { task = await takeOverTaskSpace(SPACE); } catch (e) { task = await claimTaskSpace(SPACE); } }
else task = await taskSpace(${JSON.stringify(`松果登录 · ${service.name} ${new Date().toTimeString().slice(0, 8)}`)});
let result = { ok: false };
try {
  const page = (await task.pages())[0] || (await task.newPage());
  if (!SPACE) {
    await page.goto(${JSON.stringify(login.url(origin))}, { timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  }
  const got = await page.cdp("Network.getCookies", { urls: ${JSON.stringify(login.cookieUrls(origin))} });
  const cookies = ((got && got.cookies) || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
  const need = ${JSON.stringify(login.need)};
  if (${JSON.stringify(mode)} === "check" && need.every((n) => cookies.some((c) => c.name === n && c.value))) {
    result = { ok: true, cookies };
    await task.finish({ keep: [] });
  } else {
    await task.handOff();
    result = { ok: false, waiting: true, spaceId: task.spaceId };
  }
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
}
console.log("ACORN_RESULT " + JSON.stringify(result));
`;
}

async function run(app: App, service: Service, origin: string, mode: "check" | "handoff", spaceId: number | null): Promise<LoginResult> {
  const out = mkdtempSync(path.join(app.cfg.cacheDir, "login-"));
  try {
    const { res } = await runEgo<LoginResult>(app, script(service, origin, mode, spaceId), out, 120_000);
    if (res.error) throw new Error(`没能在浏览器里打开${service.name}：${res.error}`);
    return res;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Check a sign-in with the platform and keep it; null when the platform refuses it. */
export async function connect(app: App, service: Service, origin: string, cred: Credential): Promise<Account | null> {
  try {
    const name = await service.whoami(cred, origin, getVia(app));
    const account = app.accounts.save(service.id, origin, name, cred);
    // the subscriptions that waited for this sign-in carry on now
    for (const id of app.accounts.feedIds(account.id)) queueRefresh(app, id, 5);
    log.info(`signed in to ${service.id} at ${origin} as ${name}`);
    return account;
  } catch (err) {
    if (err instanceof LoginExpiredError) return null;
    throw err;
  }
}

/** Start signing in (no spaceId), or carry on after the user said they signed in (spaceId of the page they used). */
export async function browserLogin(app: App, service: Service, origin: string, spaceId: number | null = null): Promise<BrowserLogin> {
  if (!service.login) throw new Error(`${service.name}不能用浏览器登录，请按说明手动填写`);
  if (!(await egoAvailable(app))) throw new Error("运行松果的这台电脑上没有 ego 浏览器，请按说明手动填写");
  if (spaceId !== null && !waiting.has(spaceId)) throw new Error("没有找到这次登录，请重新点「用浏览器登录」");
  let r = await run(app, service, origin, "check", spaceId);
  if (spaceId !== null) waiting.delete(spaceId);
  if (r.cookies) {
    const cred = service.login.fromCookies(r.cookies);
    const account = cred ? await connect(app, service, origin, cred) : null;
    if (account) return { account };
    // the browser had a sign-in, but the platform no longer accepts it: the user signs in anew
    r = await run(app, service, origin, "handoff", null);
  }
  if (!r.spaceId) throw new Error(`没能在浏览器里打开${service.name}`);
  waiting.set(r.spaceId, { service: service.id, origin, at: Date.now() });
  const first = spaceId === null;
  return {
    waiting: true,
    spaceId: r.spaceId,
    message: first ? `已在 ego 浏览器里打开${service.name}：登录后回到这里点「我已登录」` : `还没有看到${service.name}的登录：请在 ego 浏览器里完成登录，再点「我已登录」`,
  };
}

/** The sign-in a waiting page belongs to. */
export function waitingLogin(spaceId: number): { service: string; origin: string } | undefined {
  const cutoff = Date.now() - 2 * 3_600_000;
  for (const [id, w] of waiting) if (w.at < cutoff) waiting.delete(id);
  return waiting.get(spaceId);
}
