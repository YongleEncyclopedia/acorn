/** Reading and writing iCalendar (RFC 5545): only the parts calendars of due dates and course events use. */

export interface IcsEvent {
  uid: string;
  summary: string;
  /** Epoch ms. An all-day event starts at 00:00 UTC of its date. */
  start: number;
  end: number;
  allDay: boolean;
}

const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

/** The UTC instant of a wall-clock time in a zone (Asia/Shanghai, America/Los_Angeles…). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = 0;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, Number(p.value)]),
    );
    offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - guess;
  } catch {
    offset = 8 * 3_600_000; // an unknown zone: the school's own
  }
  return guess - offset;
}

/** A DTSTART / DTEND value. Times without a zone are read as the school's (Asia/Shanghai). */
function readTime(value: string, params: Record<string, string>, zone: string): { at: number; allDay: boolean } | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4] || params.VALUE === "DATE") return { at: Date.UTC(y, mo - 1, d), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  if (m[7]) return { at: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  return { at: zonedToUtc(y, mo, d, h, mi, s, params.TZID || zone), allDay: false };
}

export function parseIcs(text: string, zone = "Asia/Shanghai"): IcsEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: IcsEvent[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      const start = cur.DTSTART && readTime(cur.DTSTART.value, cur.DTSTART.params, zone);
      const end = cur.DTEND && readTime(cur.DTEND.value, cur.DTEND.params, zone);
      if (cur.UID && start) {
        out.push({
          uid: cur.UID.value.trim(),
          summary: unescape(cur.SUMMARY?.value || "").trim(),
          start: start.at,
          end: end ? Math.max(end.at, start.at) : start.at,
          allDay: start.allDay,
        });
      }
      cur = null;
    } else if (cur) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const [name, ...rest] = line.slice(0, colon).split(";");
      const params = Object.fromEntries(rest.map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), (v || "").replace(/^"|"$/g, "")]));
      cur[name.toUpperCase()] = { value: line.slice(colon + 1), params };
    }
  }
  return out;
}

const esc = (v: string) => v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");

/** Lines are folded at 75 octets; a multi-byte character is never split. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

export interface OutEvent {
  uid: string;
  summary: string;
  description?: string;
  start: number;
  end: number;
  allDay: boolean;
}

export function writeIcs(name: string, events: OutEvent[], now = Date.now()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Acorn//Class calendar//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(name)}`, "X-WR-TIMEZONE:Asia/Shanghai"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${esc(e.uid)}`, `DTSTAMP:${utc(now)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${date(e.start)}`, `DTEND;VALUE=DATE:${date(Math.max(e.end, e.start + 86_400_000))}`);
    else lines.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end)}`);
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push("TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
