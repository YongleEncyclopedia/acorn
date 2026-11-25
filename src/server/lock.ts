/**
 * One library, one server. A data directory records which Acorn has it open, so that a second one started on
 * the same directory — the desktop app while a server from the repository is already running, say — steps back
 * instead of joining in: two processes would each run the scheduler, fetch every feed twice and write over each
 * other's archive folders.
 *
 * The record is `data/.lock` ({ pid, port, startedAt }). A crash leaves it behind and process ids are reused,
 * so a lock only counts while its process is alive and an Acorn answers on its port.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

const file = (dataDir: string) => path.join(dataDir, ".lock");

export function readLock(dataDir: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(file(dataDir), "utf8")) as Partial<LockInfo>;
    return Number.isInteger(v.pid) && Number.isInteger(v.port) ? { pid: v.pid!, port: v.port!, startedAt: Number(v.startedAt) || 0 } : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Does an Acorn answer on this machine at `port`? */
export async function answers(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** The other Acorn that has this data directory open right now, if there is one. */
export async function lockHolder(dataDir: string, self: number = process.pid): Promise<LockInfo | null> {
  const lock = readLock(dataDir);
  if (!lock || lock.pid === self || !alive(lock.pid)) return null;
  return (await answers(lock.port)) ? lock : null;
}

/** Record that this process serves `dataDir` on `port`. Returns the function that takes the record away again. */
export function holdLock(dataDir: string, port: number): () => void {
  const mine: LockInfo = { pid: process.pid, port, startedAt: Date.now() };
  writeFileSync(file(dataDir), JSON.stringify(mine) + "\n");
  return () => {
    // only ours to remove: after a restart the next process may already have written its own
    if (readLock(dataDir)?.pid === process.pid) rmSync(file(dataDir), { force: true });
  };
}
