/**
 * HTTP client used for feeds, pages and assets.
 * - bounded body size and timeout
 * - conditional GET (ETag / Last-Modified)
 * - charset detection from header, <meta>, or XML prolog (GBK / GB2312 / Big5 pages are common on .edu.cn sites)
 */
export interface HttpOptions {
  headers?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  referer?: string | null;
  accept?: string;
  cookie?: string;
  method?: "GET" | "HEAD";
}

export interface HttpResult {
  status: number;
  ok: boolean;
  notModified: boolean;
  url: string;
  headers: Headers;
  contentType: string;
  body: Buffer;
}

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, message?: string) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_UA = "Mozilla/5.0 (compatible; Acorn/0.1; personal feed reader)";

// Connection-level failures that usually succeed on a second try (flaky proxies, servers dropping keep-alive sockets).
const TRANSIENT = /ECONNRESET|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|other side closed|socket hang up/i;
const RETRY_DELAYS = [600, 1800];

/** GET with a bounded body, retried a couple of times on transient network errors (never on timeouts or HTTP errors). */
export async function httpGet(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await httpAttempt(url, opts);
    } catch (err) {
      const retry = err instanceof HttpError && err.status === 0 && TRANSIENT.test(err.message) && attempt < RETRY_DELAYS.length;
      if (!retry) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

async function httpAttempt(url: string, opts: HttpOptions): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent || DEFAULT_UA,
    accept: opts.accept || "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...opts.headers,
  };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
  if (opts.referer) headers.referer = opts.referer;
  if (opts.cookie) headers.cookie = opts.cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  try {
    const res = await fetch(url, { method: opts.method || "GET", headers, redirect: "follow", signal: controller.signal });
    const contentType = res.headers.get("content-type") || "";
    if (res.status === 304) {
      return { status: 304, ok: true, notModified: true, url: res.url || url, headers: res.headers, contentType, body: Buffer.alloc(0) };
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) {
      controller.abort();
      throw new HttpError(413, url, `内容过大（${Math.round(declared / 1048576)} MB）`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body && opts.method !== "HEAD") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new HttpError(413, url, `内容过大（超过 ${Math.round(maxBytes / 1048576)} MB）`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      notModified: false,
      url: res.url || url,
      headers: res.headers,
      contentType,
      body: Buffer.concat(chunks),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e.cause?.code || e.cause?.message;
    throw new HttpError(0, url, cause ? `${e.message}（${cause}）` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and require a 2xx (or 304) status. */
export async function httpGetOk(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const res = await httpGet(url, opts);
  if (!res.ok) throw new HttpError(res.status, res.url, `HTTP ${res.status}`);
  return res;
}

const CHARSET_ALIASES: Record<string, string> = { gb2312: "gbk", "x-gbk": "gbk", gb_2312: "gbk", "gb_2312-80": "gbk", big5hkscs: "big5" };

function normalizeCharset(cs: string | null | undefined): string | null {
  if (!cs) return null;
  const c = cs.trim().toLowerCase().replace(/["']/g, "");
  return CHARSET_ALIASES[c] || c;
}

export function sniffCharset(body: Buffer, contentType: string): string {
  const fromHeader = normalizeCharset(contentType.match(/charset=([^;]+)/i)?.[1]);
  if (fromHeader) return fromHeader;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  const head = body.subarray(0, 4096).toString("latin1");
  const xml = head.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)?.[1];
  if (xml) return normalizeCharset(xml) || "utf-8";
  const meta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  if (meta) return normalizeCharset(meta) || "utf-8";
  return "utf-8";
}

export function decodeBody(body: Buffer, contentType = ""): string {
  const charset = sniffCharset(body, contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<{ text: string; url: string; contentType: string }> {
  const res = await httpGetOk(url, opts);
  return { text: decodeBody(res.body, res.contentType), url: res.url, contentType: res.contentType };
}
