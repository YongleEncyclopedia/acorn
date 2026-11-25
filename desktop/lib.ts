/**
 * The parts of the desktop shell that do not need Electron: its settings file, the address a user types to reach
 * another Acorn, finding a port. Kept apart so the tests can import them.
 */
import net from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The port a library is served on unless something else has it, so phones can keep one bookmark. */
export const DEFAULT_PORT = 7700;

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ShellSettings {
  /**
   * host: this computer keeps the library and serves it. client: the window shows an Acorn that runs on another
   * device. null: not chosen yet, the welcome page asks.
   */
  mode: "host" | "client" | null;
  /** host: where the library lives. */
  dataDir: string;
  /** host: the port to serve on when it is free. */
  port: number;
  /** client: the other Acorn's address (an origin, e.g. http://192.168.1.20:7700). */
  serverUrl: string;
  /** Windows / Linux: keep running in the tray when the window is closed. macOS apps stay in the Dock anyway. */
  background: boolean;
  bounds: WindowBounds | null;
}

export function defaultSettings(home: string): ShellSettings {
  return { mode: null, dataDir: path.join(home, "data"), port: DEFAULT_PORT, serverUrl: "", background: true, bounds: null };
}

/** Read the settings file; anything missing, mistyped or unreadable falls back to the default for that field. */
export function loadSettings(file: string, home: string): ShellSettings {
  const d = defaultSettings(home);
  let v: Partial<ShellSettings> = {};
  try {
    v = JSON.parse(readFileSync(file, "utf8")) as Partial<ShellSettings>;
  } catch {
    return d;
  }
  const b = v.bounds;
  return {
    mode: v.mode === "host" || v.mode === "client" ? v.mode : null,
    dataDir: typeof v.dataDir === "string" && path.isAbsolute(v.dataDir) ? v.dataDir : d.dataDir,
    port: Number.isInteger(v.port) && v.port! > 0 && v.port! < 65536 ? v.port! : d.port,
    serverUrl: typeof v.serverUrl === "string" ? v.serverUrl : "",
    background: typeof v.background === "boolean" ? v.background : d.background,
    bounds: b && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width >= 300 && b.height >= 300 ? { x: b.x, y: b.y, width: b.width, height: b.height, maximized: !!b.maximized } : null,
  };
}

/** Written to a temporary file first, so a crash mid-write cannot leave half a settings file behind. */
export function saveSettings(file: string, settings: ShellSettings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * What someone types as "where my Acorn is" → its origin, or null when that cannot be an address.
 * "192.168.1.20" and "nas.local" get http:// and Acorn's usual port; anything with a scheme or a port is taken
 * as written ("https://acorn.example.com" stays on 443).
 */
export function normalizeServerUrl(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url: URL;
  try {
    url = new URL(typedScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (!typedScheme && !url.port) url.port = String(DEFAULT_PORT);
  return url.origin;
}

/** Is `url` a page of the Acorn at `origin`? */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return !!origin && new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** The first port at or after `preferred` that nothing is listening on. */
export async function freePort(preferred: number, host = "0.0.0.0", tries = 30): Promise<number> {
  for (let port = preferred; port < preferred + tries && port < 65536; port += 1) {
    if (await canListen(port, host)) return port;
  }
  throw new Error(`端口 ${preferred}–${preferred + tries - 1} 都被占用了`);
}

/** The addresses other devices on the same network can open to reach this computer's Acorn. */
export function lanAddresses(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list || []) {
      // 169.254.x.x is what an interface gives itself when it got no address: nothing can reach it
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) out.push(`http://${i.address}:${port}`);
    }
  }
  return [...new Set(out)];
}
