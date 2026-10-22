import { Cron } from "croner";
import type { App } from "./app.ts";
import { queueRefresh } from "./feeds/refresh.ts";
import { importTick } from "./import/run.ts";
import { queueCapture } from "./archive/capture.ts";
import { recheckArchive } from "./archive/recheck.ts";
import { syncWechatBridge } from "./feeds/wechat-bridge.ts";
import { sendDigest, telegramConfigured } from "./notify/telegram.ts";
import { hostOf } from "./util/url.ts";
import { logger } from "./util/log.ts";

const log = logger("scheduler");

export interface Scheduler {
  stop: () => void;
  rescheduleDigest: () => void;
}

/**
 * Background loop:
 * - every 15 s: refresh feeds whose next_fetch_at has passed; archive the next links of a move-in
 * - every 10 min: archive starred entries that were never archived; recheck old archives for deletion/changes;
 *   subscribe to accounts newly added in we-mp-rss
 * - daily: prune old untouched entries (when retention is enabled)
 * - cron: Telegram digest
 */
export function startScheduler(app: App): Scheduler {
  const tick = () => {
    for (const f of app.feeds.due(Date.now(), 25)) queueRefresh(app, f.id);
    importTick(app);
  };
  const maintenance = () => {
    const s = app.settings.all();
    if (s.archiveOnStar) {
      for (const e of app.entries.starredWithoutArchive(20)) if (e.url) queueCapture(app, { url: e.url, entryId: e.id, method: "fetch" });
    }
    if (s.recheckDays > 0) {
      for (const a of app.archives.dueForRecheck(Date.now() - s.recheckDays * 86_400_000, 6)) {
        app.jobs.add(`recheck:${a.id}`, hostOf(a.url), () => recheckArchive(app, a.id).then(() => undefined), -5);
      }
    }
    if (s.wechatBridge.url) {
      app.jobs.add("wechat-bridge", "", () => syncWechatBridge(app).then(() => undefined, (err) => log.debug("we-mp-rss sync failed", err)), -4);
    }
  };
  const daily = () => {
    const days = app.settings.all().retentionDays;
    if (days > 0) {
      const n = app.entries.prune(days);
      if (n) log.info(`pruned ${n} old entries`);
    }
    app.db.exec("pragma optimize");
  };

  const t1 = setInterval(tick, 15_000);
  const t2 = setInterval(maintenance, 10 * 60_000);
  const t3 = setInterval(daily, 24 * 3_600_000);
  setTimeout(tick, 1500);
  setTimeout(maintenance, 60_000);

  let digest: Cron | null = null;
  const rescheduleDigest = () => {
    digest?.stop();
    digest = null;
    const s = app.settings.all();
    if (!s.digest.enabled || !telegramConfigured(app)) return;
    try {
      digest = new Cron(s.digest.cron, () => {
        sendDigest(app).catch((err) => log.warn("digest failed", err));
      });
      log.info(`digest scheduled: ${s.digest.cron}, next ${digest.nextRun()?.toLocaleString("zh-CN")}`);
    } catch (err) {
      log.warn(`invalid digest cron "${s.digest.cron}"`, err);
    }
  };
  rescheduleDigest();

  return {
    stop: () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
      digest?.stop();
    },
    rescheduleDigest,
  };
}
