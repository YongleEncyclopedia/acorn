/** Rewrite image URLs in sanitized HTML so they load through the local image proxy (hotlink-safe, cacheable, private). */
export function proxyUrl(url: string, referer?: string | null): string {
  const r = referer ? `&r=${encodeURIComponent(referer)}` : "";
  return `/api/img?u=${encodeURIComponent(url)}${r}`;
}

export function proxifyHtml(html: string, referer: string | null): string {
  if (!html) return html;
  return html
    .replace(/(<img\b[^>]*?\ssrc=")(https?:\/\/[^"]+)(")/gi, (_m, a, url, b) => `${a}${proxyUrl(decodeEntities(url), referer)}${b}`)
    .replace(/(<(?:img|source)\b[^>]*?\ssrcset=")([^"]+)(")/gi, (_m, a, set: string, b) => {
      const parts = set.split(/,\s+(?=\S)/).map((p) => {
        const [u, d] = p.trim().split(/\s+/, 2);
        return /^https?:/i.test(u) ? `${proxyUrl(decodeEntities(u), referer)}${d ? ` ${d}` : ""}` : p;
      });
      return `${a}${parts.join(", ")}${b}`;
    })
    .replace(/(<video\b[^>]*?\sposter=")(https?:\/\/[^"]+)(")/gi, (_m, a, url, b) => `${a}${proxyUrl(decodeEntities(url), referer)}${b}`);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Archived content uses relative asset paths; turn them into served URLs. */
export function archiveHtml(html: string, snapshotDirUrl: string, referer: string | null): string {
  const rewritten = html
    .replace(/(\s(?:src|poster)=")assets\//g, `$1${snapshotDirUrl}/assets/`)
    .replace(/(\shref=")attachments\//g, `$1${snapshotDirUrl}/attachments/`);
  return proxifyHtml(rewritten, referer);
}
