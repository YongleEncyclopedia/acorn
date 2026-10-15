import { logger } from "./util/log.ts";

const log = logger("jobs");

interface Job {
  key: string;
  host: string;
  run: () => Promise<void>;
  priority: number;
}

/**
 * In-memory job queue with global concurrency, per-key de-duplication and per-host politeness.
 * Background work (refreshes, full text, archiving) all flows through here.
 * Jobs are not persisted; the scheduler re-derives pending work from the database after a restart.
 */
export class JobQueue {
  private queue: Job[] = [];
  private running = new Set<string>();
  private keys = new Set<string>();
  private hostBusyUntil = new Map<string, number>();
  private activeHosts = new Map<string, number>();
  private concurrency: number;
  private hostGapMs: number;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(concurrency = 4, hostGapMs = 1200) {
    this.concurrency = concurrency;
    this.hostGapMs = hostGapMs;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Enqueue unless a job with the same key is queued or running. Returns false when de-duplicated. */
  add(key: string, host: string, run: () => Promise<void>, priority = 0): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.queue.push({ key, host, run, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
    return true;
  }

  get size(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.running.size };
  }

  /** Resolves when the queue is empty and nothing is running (used by tests and the CLI). */
  idle(): Promise<void> {
    if (!this.queue.length && !this.running.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    let soonest = Infinity;
    for (let i = 0; i < this.queue.length && this.running.size < this.concurrency; ) {
      const job = this.queue[i];
      const busyUntil = this.hostBusyUntil.get(job.host) || 0;
      const active = this.activeHosts.get(job.host) || 0;
      if (job.host && (busyUntil > now || active >= 2)) {
        soonest = Math.min(soonest, busyUntil > now ? busyUntil : now + 250);
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(job);
    }
    if (this.queue.length && Number.isFinite(soonest)) {
      this.timer = setTimeout(() => this.pump(), Math.max(50, soonest - now));
    }
    if (!this.queue.length && !this.running.size) {
      const waiters = this.idleWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  private start(job: Job): void {
    this.running.add(job.key);
    if (job.host) {
      this.activeHosts.set(job.host, (this.activeHosts.get(job.host) || 0) + 1);
      this.hostBusyUntil.set(job.host, Date.now() + this.hostGapMs);
    }
    job
      .run()
      .catch((err) => log.warn(`job ${job.key} failed`, err))
      .finally(() => {
        this.running.delete(job.key);
        this.keys.delete(job.key);
        if (job.host) this.activeHosts.set(job.host, Math.max(0, (this.activeHosts.get(job.host) || 1) - 1));
        this.pump();
      });
  }
}
