import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import type { App } from "../app.ts";
import type { PendingVerification } from "../../shared/types.ts";
import { logger } from "../util/log.ts";

const log = logger("browser");

export interface BrowserShot {
  html: string;
  mhtml: Buffer | null;
  screenshot: Buffer | null;
  finalUrl: string;
  title: string;
}

/** The page shows a captcha / login wall. The page has been handed to the user; resume with resumeBrowserCapture(spaceId). */
export class BrowserBlockedError extends Error {
  url: string;
  spaceId: number | null;
  constructor(message: string, url: string, spaceId: number | null) {
    super(message);
    this.name = "BrowserBlockedError";
    this.url = url;
    this.spaceId = spaceId;
  }
}

let available: boolean | null = null;

/** Is the ego-browser CLI installed? (cached) */
export async function egoAvailable(app: App): Promise<boolean> {
  if (available !== null) return available;
  available = await new Promise<boolean>((resolve) => {
    const p = spawn(app.cfg.egoBrowserBin, ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
  return available;
}

/** URL patterns that mean "a human has to do something in the browser first". */
const BLOCK_PATTERNS = [
  { re: /wappoc_appmsgcaptcha|mp\.weixin\.qq\.com\/mp\/.*captcha/, reason: "微信要求人机验证" },
  { re: /\/account\/unhuman|zhihu\.com\/signin/, reason: "知乎要求登录或安全验证" },
  { re: /xiaohongshu\.com\/(website-login|login)|captcha/, reason: "小红书要求登录或验证" },
  { re: /passport\.weibo\.(com|cn)/, reason: "微博要求登录" },
];

/** Captures waiting for the user to pass a verification in their browser, keyed by ego-browser space id. */
const pending = new Map<number, PendingVerification>();

export function listPending(): PendingVerification[] {
  const cutoff = Date.now() - 6 * 3_600_000;
  for (const [id, p] of pending) if (p.createdAt < cutoff) pending.delete(id);
  return [...pending.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function dropPending(spaceId: number): boolean {
  return pending.delete(spaceId);
}

export function getPending(spaceId: number): PendingVerification | undefined {
  return pending.get(spaceId);
}

/** Shared in-page capture: scroll to load lazy content, then save HTML, MHTML and a screenshot into OUT. */
const CAPTURE_FN = `
async function capturePage(page, OUT) {
  const fs = await import("node:fs/promises");
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let last = -1;
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, Math.max(400, window.innerHeight * 0.9));
      await sleep(140);
      const y = window.scrollY;
      if (y === last && window.innerHeight + y >= document.documentElement.scrollHeight - 80) break;
      last = y;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
  const html = await page.evaluate(() => "<!doctype html>\\n" + document.documentElement.outerHTML);
  await fs.writeFile(OUT + "/page.html", html);
  try {
    const snap = await page.cdp("Page.captureSnapshot", { format: "mhtml" }, { timeout: 60000 });
    if (snap && snap.data) await fs.writeFile(OUT + "/page.mhtml", snap.data);
  } catch (e) { console.error("mhtml failed", e && e.message); }
  try { await page.screenshot({ path: OUT + "/screenshot.png", fullPage: true }); }
  catch (e) {
    try { await page.screenshot({ path: OUT + "/screenshot.png" }); } catch (e2) { console.error("screenshot failed", e2 && e2.message); }
  }
  return { ok: true, title: await page.title(), url: await page.url() };
}
const BLOCKS = ${JSON.stringify(BLOCK_PATTERNS.map((b) => ({ re: b.re.source, reason: b.reason })))};
const blockedBy = (url) => BLOCKS.find((b) => new RegExp(b.re).test(url));
`;

interface ScriptResult {
  ok: boolean;
  blocked?: boolean;
  spaceId?: number;
  error?: string;
  url?: string;
  title?: string;
}

async function runEgo(app: App, script: string, out: string, timeoutMs: number): Promise<{ res: ScriptResult; read: (f: string) => Buffer | null }> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(app.cfg.egoBrowserBin, ["nodejs", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let so = "";
    let se = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error("浏览器入藏超时"));
    }, timeoutMs);
    p.stdout.on("data", (d) => (so += d));
    p.stderr.on("data", (d) => (se += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("exit", () => {
      clearTimeout(timer);
      resolve({ stdout: so, stderr: se });
    });
  });
  const line = `${stdout}\n${stderr}`.split("\n").find((l) => l.startsWith("ACORN_RESULT "));
  if (!line) throw new Error(`ego-browser 没有返回结果：${(stderr || stdout).trim().slice(-300) || "无输出"}`);
  const read = (f: string) => (existsSync(path.join(out, f)) ? readFileSync(path.join(out, f)) : null);
  return { res: JSON.parse(line.slice("ACORN_RESULT ".length)) as ScriptResult, read };
}

function toShot(res: ScriptResult, read: (f: string) => Buffer | null, url: string): BrowserShot {
  const html = read("page.html");
  if (!html) throw new Error("浏览器没有返回网页内容");
  return { html: html.toString("utf8"), mhtml: read("page.mhtml"), screenshot: read("screenshot.png"), finalUrl: res.url || url, title: res.title || "" };
}

export interface CaptureContext {
  entryId?: number | null;
  tags?: string[];
  title?: string;
}

/**
 * Render a page in the user's own browser (ego-browser / Ego Lite) and save HTML + MHTML + a full-page screenshot.
 * If the site shows a captcha or login wall, the page is handed to the user (ego-browser handOff) and a
 * BrowserBlockedError carrying the space id is thrown; after the user passes it, call resumeBrowserCapture().
 */
export async function browserCapture(app: App, url: string, ctx: CaptureContext = {}, timeoutMs = 150_000): Promise<BrowserShot> {
  if (!(await egoAvailable(app))) throw new Error("没有找到 ego-browser，无法用浏览器入藏");
  const out = mkdtempSync(path.join(app.cfg.cacheDir, "browser-"));
  const script = `${CAPTURE_FN}
const OUT = ${JSON.stringify(out)};
const task = await taskSpace(${JSON.stringify(`松果入藏 ${new Date().toTimeString().slice(0, 8)}`)});
let result = { ok: false };
let handedOff = false;
try {
  const page = task.page("p1");
  await page.goto(${JSON.stringify(url)}, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  const landed = await page.url();
  const hit = blockedBy(landed);
  if (hit) {
    await task.handOff();
    handedOff = true;
    result = { ok: false, blocked: true, error: hit.reason, url: landed, spaceId: task.spaceId };
  } else {
    result = await capturePage(page, OUT);
  }
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
} finally {
  if (!handedOff) { try { await task.finish({ keep: [] }); } catch (e) { console.error("finish failed", e && e.message); } }
}
console.log("ACORN_RESULT " + JSON.stringify(result));
`;
  try {
    const { res, read } = await runEgo(app, script, out, timeoutMs);
    if (res.blocked) {
      const spaceId = res.spaceId ?? null;
      if (spaceId) pending.set(spaceId, { spaceId, url, entryId: ctx.entryId ?? null, tags: ctx.tags, title: ctx.title, reason: res.error || "需要验证", createdAt: Date.now() });
      throw new BrowserBlockedError(`${res.error}：已在你的浏览器里打开这一页，完成验证后点「继续入藏」`, url, spaceId);
    }
    if (!res.ok) throw new Error(`浏览器入藏失败：${res.error}`);
    log.info(`browser captured ${res.url}`);
    return toShot(res, read, url);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Continue a capture after the user passed the verification in the handed-off page. */
export async function resumeBrowserCapture(app: App, spaceId: number, timeoutMs = 150_000): Promise<{ shot: BrowserShot; pending: PendingVerification }> {
  const p = pending.get(spaceId);
  if (!p) throw new Error("没有找到这个待验证的入藏任务，可能已经完成或过期");
  const out = mkdtempSync(path.join(app.cfg.cacheDir, "browser-"));
  const script = `${CAPTURE_FN}
const OUT = ${JSON.stringify(out)};
// Our own handed-off spaces are taken over; a space the user owns is claimed (the user asked for this capture).
let task;
let owned = true;
try { task = await takeOverTaskSpace(${Number(spaceId)}); } catch (e) { task = await claimTaskSpace(${Number(spaceId)}); owned = false; }
let page = null;
const up = task.userPage();
if (up) page = up.label ? up : await task.adopt(up);
if (!page) page = task.page("p1");
// Lazy page handles do not carry openedBy; the tab list does.
const tabInfo = (await task.tabs()).find((t) => t.label === page.label);
const userTab = tabInfo ? tabInfo.openedBy !== "agent" : !owned;
let result = { ok: false };
let handedOff = false;
try {
  const landed = await page.url();
  const hit = blockedBy(landed);
  const hasText = await page.evaluate(() => (document.body?.innerText || "").trim().length > 80);
  if (hit || !hasText) {
    await task.handOff();
    handedOff = true;
    result = { ok: false, blocked: true, error: hit ? hit.reason : "页面还没有显示正文", url: landed, spaceId: task.spaceId };
  } else {
    result = await capturePage(page, OUT);
  }
} catch (e) {
  result = { ok: false, error: String((e && e.message) || e) };
} finally {
  if (!handedOff) {
    try {
      // Never close the user's own tabs: give them back untouched.
      if (userTab || !owned) { if (userTab && page.label) await task.release(page.label); await task.handOff(); }
      else await task.finish({ keep: [] });
    } catch (e) { console.error("cleanup failed", e && e.message); }
  }
}
console.log("ACORN_RESULT " + JSON.stringify(result));
`;
  try {
    const { res, read } = await runEgo(app, script, out, timeoutMs);
    if (res.blocked) throw new BrowserBlockedError(`${res.error}：请先在浏览器里完成验证，看到正文后再点「继续入藏」`, p.url, spaceId);
    if (!res.ok) throw new Error(`浏览器入藏失败：${res.error}`);
    pending.delete(spaceId);
    log.info(`browser capture resumed in space ${spaceId}: ${res.url}`);
    return { shot: toShot(res, read, p.url), pending: { ...p, url: p.url || res.url || "" } };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Register a page the user already verified (used to hand Acorn an open tab). */
export function registerPending(p: PendingVerification): void {
  pending.set(p.spaceId, p);
}
