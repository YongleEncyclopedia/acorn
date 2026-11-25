/**
 * Runs Acorn's server for the desktop app: the same `src/server/main.ts` the repository runs, as a child process
 * on the Node that Electron carries (no separate runtime, no build step — it strips the TypeScript like Node does).
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { appendFileSync, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { answers, lockHolder } from "../src/server/lock.ts";
import { freePort } from "./lib.ts";

export interface LocalServer {
  /** Where the window finds it. */
  origin: string;
  port: number;
  /** True when another Acorn already had this library open and the app only shows it (nothing was started). */
  attached: boolean;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The program: the repository root, or the app's resources. */
  root: string;
  dataDir: string;
  /** Where the user's source plugins live; filled with the samples the first time. */
  pluginsDir: string;
  preferredPort: number;
  logFile: string;
  /** Optional settings the server reads from the environment (TELEGRAM_BOT_TOKEN, RSSHUB_BASE…), one per line. */
  envFile: string;
  /** Called when the server stops although nobody asked it to. */
  onExit: (code: number, logTail: string) => void;
}

const MAX_LOG = 2 * 1024 * 1024;

/** GUI apps on macOS start with a bare PATH; the server looks for `ego-browser` and friends where a shell would. */
function shellPath(): string {
  const home = process.env.HOME || "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", home && path.join(home, ".local/bin"), home && path.join(home, "bin")].filter(Boolean);
  return [...new Set([...(process.env.PATH || "").split(path.delimiter), ...extra])].filter(Boolean).join(path.delimiter);
}

async function untilReady(port: number, exited: Promise<number>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let gone: number | null = null;
  void exited.then((code) => (gone = code));
  while (Date.now() < deadline) {
    if (gone !== null) throw new Error(`服务没能启动（退出码 ${gone}）`);
    if (await answers(port, 800)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("服务启动超时");
}

export async function startLocalServer(opts: StartOptions): Promise<LocalServer> {
  mkdirSync(opts.dataDir, { recursive: true });

  // A server started some other way (from the repository, by launchd) may already have this library open.
  // Two must not write to it, and there is no need for a second one: show the one that is there.
  const holder = await lockHolder(opts.dataDir);
  if (holder) return { origin: `http://127.0.0.1:${holder.port}`, port: holder.port, attached: true, stop: async () => undefined };

  // Plugins are the user's own files, so they live outside the app, which must not be written into.
  if (!existsSync(opts.pluginsDir)) cpSync(path.join(opts.root, "plugins"), opts.pluginsDir, { recursive: true });

  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  if (existsSync(opts.logFile) && statSync(opts.logFile).size > MAX_LOG) writeFileSync(opts.logFile, "");
  let tail = "";
  const record = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    tail = (tail + text).slice(-6000);
    try {
      appendFileSync(opts.logFile, text);
    } catch {
      /* a log that cannot be written must not stop the reader */
    }
  };

  const port = await freePort(opts.preferredPort);
  const child: UtilityProcess = utilityProcess.fork(path.join(opts.root, "src/server/main.ts"), [], {
    cwd: opts.root,
    serviceName: "Acorn Server",
    stdio: "pipe",
    execArgv: ["--disable-warning=ExperimentalWarning", `--env-file-if-exists=${opts.envFile}`],
    env: {
      ...process.env,
      // (Windows spells it Path, and its environment does not tell the two apart: leave it as it is there)
      ...(process.platform === "win32" ? {} : { PATH: shellPath() }),
      ACORN_PORT: String(port),
      // reachable from the phone and the tablet: that is what the app is for
      ACORN_HOST: process.env.ACORN_HOST || "0.0.0.0",
      ACORN_DATA_DIR: opts.dataDir,
      ACORN_PLUGINS_DIR: opts.pluginsDir,
    },
  });
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  let stopping = false;
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
  try {
    await untilReady(port, exited);
  } catch (err) {
    stopping = true;
    child.kill();
    throw new Error(`${(err as Error).message}\n\n${tail.trim()}`);
  }
  void exited.then((code) => !stopping && opts.onExit(code, tail.trim()));

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    attached: false,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      // ask first: the server closes its database and gives the library back; insist if it does not answer
      child.postMessage("shutdown");
      const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
      if (!done) child.kill();
    },
  };
}
