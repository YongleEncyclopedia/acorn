import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { App } from "../app.ts";

const COOKIE = "acorn_session";
const YEAR = 365 * 24 * 3600;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(expected, actual);
}

function secret(app: App): string {
  let s = app.settings.getRaw("_secret");
  if (!s) {
    s = randomBytes(32).toString("base64");
    app.settings.setRaw("_secret", s);
  }
  return s;
}

function sign(app: App, value: string): string {
  return createHmac("sha256", secret(app)).update(value).digest("base64url");
}

export function hasPassword(app: App): boolean {
  return !!app.settings.getRaw("_password");
}

export function setPassword(app: App, password: string): void {
  app.settings.setRaw("_password", hashPassword(password));
  app.settings.setRaw("_secret", randomBytes(32).toString("base64")); // invalidates existing sessions
}

export function issueSession(app: App, c: Context): void {
  const iat = String(Date.now());
  const secure = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:");
  setCookie(c, COOKIE, `${iat}.${sign(app, iat)}`, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: YEAR, secure });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

function validSession(app: App, c: Context): boolean {
  const v = getCookie(c, COOKIE);
  if (!v) return false;
  const [iat, sig] = v.split(".");
  if (!iat || !sig) return false;
  const expected = sign(app, iat);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization") || "";
  const m = h.match(/^(?:Bearer|GoogleLogin auth=)\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

export function isAuthenticated(app: App, c: Context): boolean {
  if (validSession(app, c)) return true;
  const token = bearer(c);
  return !!(token && app.tokens.verify(token));
}

export function remoteAddress(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress || "";
}

export function isLoopback(c: Context): boolean {
  const ip = remoteAddress(c);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function requireAuth(app: App): MiddlewareHandler {
  return async (c, next) => {
    if (isAuthenticated(app, c)) return next();
    return c.json({ error: "unauthorized", message: "请先登录" }, 401);
  };
}

/** Naive login throttle: 8 attempts per 10 minutes per address. */
const attempts = new Map<string, number[]>();
export function loginAllowed(c: Context): boolean {
  const ip = remoteAddress(c) || "unknown";
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 600_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length <= 8;
}
