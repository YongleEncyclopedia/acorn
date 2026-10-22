/**
 * A backup is a second data directory. The database is copied with SQLite's online backup (consistent even while
 * Acorn is writing), snapshot folders are copied once (they never change after they are written) and the icons
 * refreshed; nothing is ever deleted from the backup. The result works as ACORN_DATA_DIR as it is.
 */
import { backup as sqliteBackup } from "node:sqlite";
import { cp } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { App } from "./app.ts";
import type { BackupReport, BackupStatus } from "../shared/types.ts";
import { VERSION } from "./config.ts";
import { logger } from "./util/log.ts";

const log = logger("backup");
let running: Promise<BackupReport> | null = null;
let progress: BackupStatus["progress"] = null;

export function backupStatus(app: App): BackupStatus {
  const raw = app.settings.getRaw("_backup");
  let last: BackupReport | null = null;
  try {
    last = raw ? (JSON.parse(raw) as BackupReport) : null;
  } catch {
    last = null;
  }
  return { running: !!running, progress, last };
}

/** Anywhere but inside the data directory (or around it): the backup would otherwise copy itself. */
export function checkBackupDir(app: App, dir: string): string | null {
  if (!dir) return "还没有设置备份目录";
  if (!path.isAbsolute(dir)) return "备份目录需要是绝对路径";
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(app.cfg.dataDir, dir)) return "备份目录不能在数据目录里面";
  if (inside(dir, app.cfg.dataDir)) return "备份目录不能包含数据目录";
  return null;
}

/** Snapshot folders (the ones with a meta.json, i.e. completely written), relative to the archive directory. */
function snapshotDirs(archiveDir: string): string[] {
  const out: string[] = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
  for (const y of dirs(archiveDir))
    for (const m of dirs(path.join(archiveDir, y)))
      for (const a of dirs(path.join(archiveDir, y, m)))
        for (const s of dirs(path.join(archiveDir, y, m, a))) if (existsSync(path.join(archiveDir, y, m, a, s, "meta.json"))) out.push(`${y}/${m}/${a}/${s}`);
  return out;
}

function dirBytes(dir: string): number {
  let n = 0;
  for (const ent of readdirSync(dir, { recursive: true, withFileTypes: true })) if (ent.isFile()) n += statSync(path.join(ent.parentPath, ent.name)).size;
  return n;
}

/** Run a backup now (or join the one running). The report is also kept as the last result. */
export function runBackup(app: App, dir = app.settings.all().backup.dir): Promise<BackupReport> {
  if (running) return running;
  running = backupInto(app, dir).finally(() => {
    running = null;
    progress = null;
  });
  return running;
}

async function backupInto(app: App, dir: string): Promise<BackupReport> {
  const started = Date.now();
  const report: BackupReport = { at: started, ok: false, error: null, dir, snapshots: 0, copied: 0, bytes: 0, ms: 0 };
  app.events.emit({ type: "backup", running: true });
  try {
    const bad = checkBackupDir(app, dir);
    if (bad) throw new Error(bad);
    mkdirSync(path.join(dir, "archive"), { recursive: true });

    // 1. the database, written next to the old copy and swapped in; a stale WAL beside it would corrupt it
    const tmp = path.join(dir, "acorn.db.tmp");
    rmSync(tmp, { force: true });
    await sqliteBackup(app.db.raw, tmp);
    for (const f of ["acorn.db-wal", "acorn.db-shm"]) rmSync(path.join(dir, f), { force: true });
    renameSync(tmp, path.join(dir, "acorn.db"));

    // 2. snapshots that are not there yet, each copied whole and renamed into place
    const snaps = snapshotDirs(app.cfg.archiveDir);
    progress = { copied: 0, total: snaps.length };
    for (const rel of snaps) {
      report.snapshots++;
      const dest = path.join(dir, "archive", rel);
      if (existsSync(path.join(dest, "meta.json"))) continue;
      const part = `${dest}.part`;
      rmSync(part, { recursive: true, force: true });
      await cp(path.join(app.cfg.archiveDir, rel), part, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      renameSync(part, dest);
      report.copied++;
      report.bytes += dirBytes(dest);
      progress = { copied: report.copied, total: snaps.length };
      if (report.copied % 25 === 0) app.events.emit({ type: "backup", running: true, copied: report.copied, total: snaps.length });
    }

    // 3. small things that do change
    if (existsSync(app.cfg.iconsDir)) await cp(app.cfg.iconsDir, path.join(dir, "icons"), { recursive: true, force: true });
    writeFileSync(
      path.join(dir, "backup.json"),
      JSON.stringify({ generator: `Acorn 松果 ${VERSION}`, at: new Date(started).toISOString(), from: app.cfg.dataDir, snapshots: report.snapshots, copied: report.copied }, null, 2),
    );
    report.ok = true;
    log.info(`backup to ${dir}: ${report.snapshots} snapshots, ${report.copied} new, ${Math.round(report.bytes / 1048576)} MB copied`);
  } catch (err) {
    report.error = (err as Error).message;
    log.warn(`backup to ${dir} failed`, err);
  }
  report.ms = Date.now() - started;
  app.settings.setRaw("_backup", JSON.stringify(report));
  app.events.emit({ type: "backup", running: false, ok: report.ok, error: report.error });
  return report;
}
