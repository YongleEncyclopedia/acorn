const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function relTime(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "";
  const diff = now - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(t);
  if (t >= startOfDay(now)) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (t >= startOfDay(now) - 86_400_000) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function dayLabel(t: number, now = Date.now()): string {
  const sd = startOfDay(t);
  const today = startOfDay(now);
  if (sd === today) return "今天";
  if (sd === today - 86_400_000) return "昨天";
  if (sd === today - 2 * 86_400_000) return "前天";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEK[d.getDay()]}`;
}

export function dayKey(t: number): number {
  return startOfDay(t);
}

export function fullDate(t: number | null | undefined): string {
  if (!t) return "";
  const d = new Date(t);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortDate(t: number | null | undefined): string {
  if (!t) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayHeading(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEK[d.getDay()]}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Reading time: CJK ~ 420 chars/min, mixed counts ~ 330 units/min. */
export function readingTime(words: number): string {
  if (!words) return "";
  const m = Math.max(1, Math.round(words / 360));
  return `${m} 分钟`;
}

export function greeting(now = Date.now()): string {
  const h = new Date(now).getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function hostname(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
