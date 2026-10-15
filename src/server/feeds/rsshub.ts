/** RSSHub integration: routes are stored as "/namespace/path" and resolved against the configured instance. */

export function parseRsshubInput(input: string, knownBases: string[] = []): string | null {
  const s = input.trim();
  if (s.startsWith("rsshub://")) return normalizeRoute(s.slice("rsshub://".length));
  for (const base of knownBases.filter(Boolean)) {
    if (s.startsWith(base + "/")) return normalizeRoute(s.slice(base.length));
  }
  try {
    const u = new URL(s);
    if (/(^|\.)rsshub\.app$/.test(u.hostname)) return normalizeRoute(u.pathname + u.search);
  } catch {
    /* not a URL */
  }
  return null;
}

function normalizeRoute(route: string): string {
  const r = route.replace(/^\/*/, "/");
  const u = new URL(r, "http://x");
  u.searchParams.delete("key");
  u.searchParams.delete("code");
  return u.pathname.replace(/\/+$/, "") + (u.search || "");
}

export function rsshubUrl(route: string, base: string, key?: string): string {
  const u = new URL(base.replace(/\/+$/, "") + normalizeRoute(route));
  if (key) u.searchParams.set("key", key);
  return u.toString();
}
