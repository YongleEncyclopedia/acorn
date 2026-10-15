/** URL helpers: absolutize, canonicalize (for de-duplication), host checks. */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^spm$/i,
  /^from$/i,
  /^share_(source|medium|token|from)$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_(cid|eid)$/i,
  /^ref(_src)?$/i,
  /^isappinstalled$/i,
  /^scene$/i,
  /^chksm$/i,
  /^clicktime$/i,
  /^enterid$/i,
  /^sessionid$/i,
  /^subscene$/i,
  /^ascene$/i,
  /^devicetype$/i,
  /^version$/i,
  /^nettype$/i,
  /^abtest_cookie$/i,
  /^lang$/i,
  /^exportkey$/i,
  /^pass_ticket$/i,
  /^wx_header$/i,
  /^xtrack$/i,
  /^xsec_(token|source)$/i,
];

export function absolutize(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("javascript:") || h.startsWith("#")) return null;
  try {
    return new URL(h, base).toString();
  } catch {
    return null;
  }
}

/** Canonical form of a URL used to identify "the same article" across captures. */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  if (u.protocol === "http:" && /(^|\.)(weixin\.qq\.com|sspai\.com|zhihu\.com|bilibili\.com)$/.test(u.hostname)) {
    u.protocol = "https:";
  }
  // WeChat article links: the identity is __biz/mid/idx/sn (or the /s/<id> short form).
  const keep = u.hostname === "mp.weixin.qq.com" ? new Set(["__biz", "mid", "idx", "sn"]) : null;
  for (const key of [...u.searchParams.keys()]) {
    if (keep ? !keep.has(key) : TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  let s = u.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  return s;
}

export function hostOf(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}
