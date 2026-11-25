/**
 * The platforms Acorn signs in to, to read what the user's own account sees there (设置 → 账号). Each one says
 * where it lives, how a sign-in is obtained (in the user's browser, or pasted by hand) and how to check one.
 * The built-in plugins that read with them live in src/server/feeds/builtin/.
 */
import type { App } from "../app.ts";
import type { AccountService } from "../../shared/types.ts";
import type { Credential } from "../store/accounts.ts";
import { httpGet, decodeBody } from "../util/http.ts";
import { zsxqService } from "../feeds/builtin/zsxq.ts";
import { canvasService } from "../feeds/builtin/canvas.ts";
import { jwbService } from "../feeds/builtin/jwb.ts";

/** A GET that does not throw on error statuses: platforms say "signed out" in their own ways. */
export type Get = (url: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

/** A cookie as the browser keeps it. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

export interface Service extends AccountService {
  /** Signing in in the user's browser: the page to open, whose cookies make up the sign-in, and which ones. */
  login?: {
    url: (origin: string) => string;
    cookieUrls: (origin: string) => string[];
    /** The cookies that are only there once the user is signed in. */
    need: string[];
    /** The sign-in made of the browser's cookies, or null while the user is not signed in. */
    fromCookies: (cookies: BrowserCookie[]) => Credential | null;
  };
  /** What was pasted by hand, as a credential (default: a token, or a cookie header). */
  fromManual?: (value: string) => Credential;
  /** Who the credential belongs to. Throws LoginExpiredError when the platform refuses it. */
  whoami: (cred: Credential, origin: string, get: Get) => Promise<string>;
  /** The headers that sign a request in. */
  headers: (cred: Credential) => Record<string, string>;
  /**
   * Pictures and files at the platform's own address that only load signed in (Canvas files without a `verifier`):
   * the image proxy and archiving send the sign-in for these paths, and only for these.
   */
  assets?: RegExp;
}

export const SERVICES: Service[] = [zsxqService, canvasService, jwbService];

export const serviceById = (id: string): Service | undefined => SERVICES.find((s) => s.id === id);

/** What the settings page is told about a service (the parts that are code stay here). */
export const describeService = (s: Service, browser: boolean): AccountService => ({
  id: s.id,
  name: s.name,
  origin: s.origin,
  originEditable: s.originEditable,
  browserLogin: browser && !!s.login,
  manual: s.manual,
});

export function getVia(app: App): Get {
  return async (url, headers) => {
    const res = await httpGet(url, { userAgent: app.cfg.pageUserAgent, headers, timeoutMs: 20_000 });
    return { status: res.status, text: decodeBody(res.body, res.contentType) };
  };
}

/** An address as typed (oc.sjtu.edu.cn, https://oc.sjtu.edu.cn/courses) reduced to its origin. */
export function normalizeOrigin(input: string, fallback: string): string {
  const raw = (input || "").trim();
  if (!raw) return fallback;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return fallback;
  }
}
