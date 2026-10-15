/**
 * Minimal MHTML (multipart/related) reader for snapshots produced by Chromium's Page.captureSnapshot.
 * Returns the main HTML document and a map of resource URL → bytes, so images that need a login
 * or a referer can be archived from the browser's own copy without re-downloading.
 */
export interface MhtmlResource {
  type: string;
  body: Buffer;
}

export interface Mhtml {
  url: string | null;
  html: string | null;
  resources: Map<string, MhtmlResource>;
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function decodeQuotedPrintable(input: string): Buffer {
  const soft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i += 1) {
    const c = soft[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = soft.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else bytes.push(...Buffer.from(c, "utf8"));
    }
  }
  return Buffer.from(bytes);
}

export function parseMhtml(raw: Buffer | string): Mhtml {
  const text = typeof raw === "string" ? raw : raw.toString("latin1");
  const headerEnd = text.search(/\r?\n\r?\n/);
  const top = parseHeaders(text.slice(0, headerEnd));
  const boundary = top["content-type"]?.match(/boundary="?([^";]+)"?/i)?.[1];
  const result: Mhtml = { url: top["snapshot-content-location"] || null, html: null, resources: new Map() };
  if (!boundary) return result;
  const parts = text.split(`--${boundary}`);
  for (const part of parts.slice(1)) {
    if (part.startsWith("--")) break;
    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const headers = parseHeaders(part.slice(0, sep));
    const bodyRaw = part.slice(sep).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    const enc = (headers["content-transfer-encoding"] || "binary").toLowerCase();
    let body: Buffer;
    if (enc === "base64") body = Buffer.from(bodyRaw.replace(/\s+/g, ""), "base64");
    else if (enc === "quoted-printable") body = decodeQuotedPrintable(bodyRaw);
    else body = Buffer.from(bodyRaw, "latin1");
    const type = (headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const loc = headers["content-location"];
    if (type === "text/html" && result.html === null) {
      result.html = body.toString("utf8");
      if (!result.url && loc) result.url = loc;
      continue;
    }
    if (loc) result.resources.set(loc, { type, body });
  }
  return result;
}
