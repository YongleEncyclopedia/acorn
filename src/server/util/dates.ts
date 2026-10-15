/**
 * Lenient date parsing for feeds and scraped pages, including common Chinese formats:
 * "2026-10-13", "2026/10/13 08:30", "2026年10月13日", "10-13", "3小时前", "昨天 08:30", "刚刚".
 * Dates without a timezone are interpreted in the server's local timezone.
 * Returns epoch milliseconds or null.
 */
export function parseLooseDate(input: unknown, now: number = Date.now()): number | null {
  if (input == null) return null;
  if (typeof input === "number") return input > 1e12 ? input : input > 1e9 ? input * 1000 : null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.getTime();
  const raw = String(input).trim();
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ");

  if (/^刚刚|^just now/i.test(s)) return now;
  const rel = s.match(/(\d+)\s*(秒|分钟|分|小时|时|天|日|周|个月|月|年)\s*前/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const mult: Record<string, number> = {
      秒: 1e3, 分钟: 6e4, 分: 6e4, 小时: 36e5, 时: 36e5, 天: 864e5, 日: 864e5, 周: 6048e5, 个月: 2592e6, 月: 2592e6, 年: 31536e6,
    };
    return now - n * (mult[unit] ?? 0);
  }
  const relEn = s.match(/(\d+)\s*(second|minute|min|hour|hr|day|week|month|year)s?\s+ago/i);
  if (relEn) {
    const n = Number(relEn[1]);
    const unit = relEn[2].toLowerCase();
    const mult: Record<string, number> = { second: 1e3, minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
    return now - n * (mult[unit] ?? 0);
  }
  const dayWord = s.match(/^(今天|昨天|前天)\s*(\d{1,2}):(\d{2})?/);
  if (dayWord) {
    const d = new Date(now);
    const back = dayWord[1] === "今天" ? 0 : dayWord[1] === "昨天" ? 1 : 2;
    d.setDate(d.getDate() - back);
    d.setHours(Number(dayWord[2] ?? 0), Number(dayWord[3] ?? 0), 0, 0);
    return d.getTime();
  }

  // ISO 8601 and RFC 2822 with explicit zone: trust the platform parser.
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || /[+-]\d{2}:?\d{2}$|GMT|UTC|Z$/i.test(s) || /^[A-Za-z]{3},/.test(s)) {
    const t = Date.parse(s.replace(/(\d)(CST)$/i, "$1+0800"));
    if (!Number.isNaN(t)) return t;
  }

  // Split date widgets common on .edu.cn list pages: "10 2026.10" (day, then year.month) or "2026.10 10".
  const dayFirst = s.match(/^(\d{1,2})\s+(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/);
  if (dayFirst) {
    const t = new Date(Number(dayFirst[2]), Number(dayFirst[3]) - 1, Number(dayFirst[1])).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const ymThenDay = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?\s+(\d{1,2})\s*日?$/);
  if (ymThenDay) {
    const t = new Date(Number(ymThenDay[1]), Number(ymThenDay[2]) - 1, Number(ymThenDay[3])).getTime();
    return Number.isNaN(t) ? null : t;
  }

  const full = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\D{0,3}(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (full) {
    const [, y, mo, d, h, mi, se] = full;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(se ?? 0)).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const short = s.match(/(?:^|\D)(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\D{0,3}(\d{1,2}):(\d{2}))?(?:\D|$)/);
  if (short) {
    const [, mo, d, h, mi] = short;
    const ref = new Date(now);
    let t = new Date(ref.getFullYear(), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0)).getTime();
    if (t > now + 864e5) t = new Date(ref.getFullYear() - 1, Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0)).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Find the first date-looking substring inside arbitrary text (used by the HTML list auto-detector). */
export const DATE_PATTERN = /(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}日?)|((?:^|[^\d])\d{1,2}\s*[-/月]\s*\d{1,2}日?(?:[^\d]|$))/;

/** A short text that is (only) a date, including split widgets like "10 2026.10". */
export function isDateText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 30) return false;
  return DATE_PATTERN.test(t) || /^\d{1,2}\s+\d{4}\s*[-/.年]\s*\d{1,2}月?$/.test(t) || /^\d{4}\s*[-/.年]\s*\d{1,2}月?\s+\d{1,2}日?$/.test(t);
}
