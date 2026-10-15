/** Tiny leveled logger with an in-memory ring buffer (exposed at /api/logs). */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: LogLevel = (process.env.ACORN_LOG_LEVEL as LogLevel) || "info";

export interface LogLine {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const ring: LogLine[] = [];

function fmt(extra: unknown): string {
  if (extra instanceof Error) return extra.message;
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

export function logger(scope: string) {
  const emit = (level: LogLevel, msg: string, extra?: unknown) => {
    const line: LogLine = { at: Date.now(), level, scope, msg: extra === undefined ? msg : `${msg} ${fmt(extra)}` };
    ring.push(line);
    if (ring.length > 800) ring.shift();
    if (ORDER[level] < ORDER[MIN] || process.env.ACORN_SILENT) return;
    const ts = new Date(line.at).toTimeString().slice(0, 8);
    const out = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${line.msg}`;
    if (level === "error" || level === "warn") console.error(out);
    else console.log(out);
  };
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", msg, extra),
  };
}

export function recentLogs(limit = 300): LogLine[] {
  return ring.slice(-limit);
}
