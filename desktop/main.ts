/**
 * 松果 as a desktop app. One window showing the reader, and — when this computer keeps the library — Acorn's
 * server running beside it as a child process. Nothing of the reader lives here: the window simply opens the
 * same web app a browser would, from the server it started (or from another Acorn the user pointed it at).
 *
 * Run from the repository with `npm start` in desktop/ (after `npm run build` at the root); packaged with
 * electron-builder (desktop/electron-builder.yml). Electron's Node runs these .ts files as they are.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, Tray, type IpcMainInvokeEvent, type WebContents } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/server/config.ts";
import { lanAddresses, loadSettings, normalizeServerUrl, sameOrigin, saveSettings, type ShellSettings } from "./lib.ts";
import { buildAppMenu, buildTrayMenu, popupContextMenu, type MenuContext } from "./menu.ts";
import { startLocalServer, type LocalServer } from "./server.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const mac = process.platform === "darwin";

// Everything the app keeps — its own settings, the library unless it was put elsewhere, logs — sits in one
// folder with a plain name; a copy run from the repository gets its own so it cannot disturb the installed one.
const HOME = process.env.ACORN_DESKTOP_HOME || path.join(app.getPath("appData"), app.isPackaged ? "Acorn" : "Acorn-dev");
app.setName("松果");
app.setPath("userData", HOME);
app.setPath("sessionData", path.join(HOME, "browser"));

const SETTINGS_FILE = path.join(HOME, "shell.json");
const LOG_FILE = path.join(HOME, "logs", "server.log");
const WELCOME = path.join(import.meta.dirname, "welcome", "index.html");
const ICON = path.join(import.meta.dirname, "icons", "icon.png");

/**
 * Where the window buttons go on macOS: in line with the reader's 52px bars, or — in a window narrower than the
 * reader's 980px breakpoint — up in the 30px strip the bars make for them (web/src/styles/app.css).
 */
const BUTTONS = { wide: { x: 18, y: 19 }, compact: { x: 13, y: 8 } };

/** What the shell's own page is showing; null while the window shows the reader. */
type View = { name: "welcome" | "starting" | "error"; message?: string; detail?: string };

let settings: ShellSettings = loadSettings(SETTINGS_FILE, HOME);
let view: View | null = { name: "starting" };
let server: LocalServer | null = null;
/** The Acorn the window shows: the local server, or another device's. */
let origin = "";
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const save = (patch: Partial<ShellSettings>): void => {
  settings = { ...settings, ...patch };
  saveSettings(SETTINGS_FILE, settings);
};

// ───────────────────────── what the window shows ─────────────────────────

function render(): void {
  if (!win) return;
  if (view) void win.loadFile(WELCOME);
  else void win.loadURL(origin);
  refreshMenus();
}

function show(next: View | null): void {
  view = next;
  render();
}

async function openHost(): Promise<void> {
  show({ name: "starting" });
  try {
    // a server started from a repository keeps its plugins next to its data; the app's own go in its folder
    const beside = path.join(path.dirname(settings.dataDir), "plugins");
    server = await startLocalServer({
      root: ROOT,
      dataDir: settings.dataDir,
      pluginsDir: existsSync(beside) ? beside : path.join(HOME, "plugins"),
      preferredPort: settings.port,
      logFile: LOG_FILE,
      envFile: path.join(HOME, "acorn.env"),
      onExit: (code, log) => {
        server = null;
        if (!quitting) show({ name: "error", message: `松果的服务意外停止了（退出码 ${code}）`, detail: log });
      },
    });
    origin = server.origin;
    show(null);
  } catch (err) {
    server = null;
    const [message, ...rest] = (err as Error).message.split("\n\n");
    show({ name: "error", message, detail: rest.join("\n\n") });
  }
}

/** Is there an Acorn at this address? Asked from here rather than from the page, which may not fetch across origins. */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000) });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function openClient(): Promise<void> {
  show({ name: "starting", message: `正在连接 ${settings.serverUrl}` });
  if (await reachable(settings.serverUrl)) {
    origin = settings.serverUrl;
    show(null);
  } else {
    show({ name: "error", message: `连不上 ${settings.serverUrl}`, detail: "请确认那台设备上的松果正在运行，并且两台设备在同一个网络里（或者都连着 Tailscale）。" });
  }
}

function open(): Promise<void> {
  if (settings.mode === "host") return openHost();
  if (settings.mode === "client" && settings.serverUrl) return openClient();
  show({ name: "welcome" });
  return Promise.resolve();
}

async function stopServer(): Promise<void> {
  const s = server;
  server = null;
  await s?.stop();
}

// ───────────────────────── window ─────────────────────────

/** Saved bounds are only used if that spot is still on a screen (the external display may be gone). */
function restoredBounds(): { x?: number; y?: number; width: number; height: number } {
  const b = settings.bounds;
  if (!b) return { width: 1320, height: 860 };
  const onScreen = b.x !== undefined && b.y !== undefined && screen.getAllDisplays().some((d) => b.x! >= d.workArea.x - 40 && b.y! >= d.workArea.y - 40 && b.x! < d.workArea.x + d.workArea.width - 80 && b.y! < d.workArea.y + d.workArea.height - 80);
  return onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}

function rememberBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const maximized = win.isMaximized();
  save({ bounds: { ...(maximized ? settings.bounds || win.getBounds() : win.getBounds()), maximized } });
}

function isWelcome(url: string): boolean {
  try {
    return fileURLToPath(url.split(/[?#]/)[0]) === WELCOME;
  } catch {
    return false;
  }
}

/** Links leave the app: the reader is for reading what is in the library, the browser for the rest of the web. */
function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    // the library's own files (an archived page, its Markdown) open in a plain window that shares the sign-in
    if (sameOrigin(url, origin)) return { action: "allow", overrideBrowserWindowOptions: { width: 1040, height: 820, titleBarStyle: "default", autoHideMenuBar: true, icon: ICON } };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, origin) || isWelcome(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: "松果",
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141311" : "#f3efe7",
    // macOS: no title bar; the reader's own top bars carry the window buttons and move the window (app.css)
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: BUTTONS.wide } : { autoHideMenuBar: true }),
    webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (settings.bounds?.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());
  w.on("resize", rememberBounds);
  w.on("move", rememberBounds);
  w.on("close", (event) => {
    rememberBounds();
    // Windows / Linux: closing the window leaves the library being served and refreshed, from the tray
    if (!quitting && !mac && tray && settings.background && settings.mode === "host") {
      event.preventDefault();
      w.hide();
    }
  });
  w.on("closed", () => {
    if (win === w) win = null;
  });
  const fullscreen = () => w.webContents.send("shell:fullscreen", w.isFullScreen());
  w.on("enter-full-screen", fullscreen);
  w.on("leave-full-screen", fullscreen);
  w.on("focus", refreshMenus);
  w.webContents.on("dom-ready", fullscreen);
  w.webContents.on("context-menu", (_event, params) => popupContextMenu(w, params));
  w.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a load we replaced ourselves; anything else means the Acorn the window was showing is not answering
    if (isMainFrame && code !== -3 && !view && sameOrigin(url, origin)) show({ name: "error", message: `打不开 ${origin}`, detail: description });
  });
  return w;
}

function showWindow(): void {
  if (!win) {
    win = createWindow();
    render();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// ───────────────────────── menus, tray ─────────────────────────

/** Hand a menu command to the reader; if its page is still loading, once it is there. */
function sendCommand(command: string): void {
  showWindow();
  if (!win || view) return;
  const contents = win.webContents;
  const send = () => !contents.isDestroyed() && contents.send("shell:command", command);
  if (contents.isLoading()) contents.once("did-finish-load", () => setTimeout(send, 400));
  else send();
}

const menuContext: MenuContext = {
  command: sendCommand,
  reading: () => !view && !!win,
  mode: () => settings.mode,
  addresses: () => (server && !view ? lanAddresses(server.port) : []),
  showWindow,
  showData: () => void shell.openPath(settings.dataDir),
  showLog: () => (existsSync(LOG_FILE) ? shell.showItemInFolder(LOG_FILE) : void shell.openPath(HOME)),
  chooseAgain: () => {
    showWindow();
    void stopServer().then(() => show({ name: "welcome" }));
  },
  // Linux has no one way to start an app at login
  loginItem: process.platform === "linux" ? null : { get: () => app.getLoginItemSettings().openAtLogin, set: (on) => app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] }) },
  background: mac ? null : { get: () => settings.background, set: (on) => save({ background: on }) },
  quit: () => app.quit(),
};

function refreshMenus(): void {
  Menu.setApplicationMenu(buildAppMenu(menuContext));
  tray?.setContextMenu(buildTrayMenu(menuContext));
}

function createTray(): void {
  if (mac || tray) return; // macOS keeps the app in the Dock
  try {
    tray = new Tray(path.join(import.meta.dirname, "icons", "tray.png"));
    tray.setToolTip("松果");
    tray.on("click", showWindow);
  } catch {
    tray = null; // no tray on this desktop: closing the window quits, as it would anywhere else
  }
}

// ───────────────────────── the welcome page's requests ─────────────────────────

/** Only the shell's own page may ask for these; the reader (and any site a link leads to) may not. */
function fromWelcome(event: IpcMainInvokeEvent): boolean {
  return isWelcome(event.senderFrame?.url || "");
}

function handle<T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, (event, ...args) => (fromWelcome(event) ? fn(...args) : null));
}

/** A folder that already holds a library is taken over as it is; worth telling the user before they choose it. */
const hasLibrary = (dir: string): boolean => existsSync(path.join(dir, "acorn.db"));

handle("shell:state", () => ({
  view: view || { name: "starting" },
  version: VERSION,
  platform: process.platform,
  dataDir: settings.dataDir,
  hasLibrary: hasLibrary(settings.dataDir),
  serverUrl: settings.serverUrl,
}));

handle("shell:pick-folder", async () => {
  if (!win) return null;
  const picked = await dialog.showOpenDialog(win, { title: "松果的数据放在哪里", defaultPath: settings.dataDir, properties: ["openDirectory", "createDirectory"], buttonLabel: "放在这里" });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return { dir: picked.filePaths[0], hasLibrary: hasLibrary(picked.filePaths[0]) };
});

handle("shell:host", (dataDir) => {
  const dir = typeof dataDir === "string" && path.isAbsolute(dataDir) ? dataDir : path.join(HOME, "data");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `不能使用这个文件夹：${(err as Error).message}` };
  }
  save({ mode: "host", dataDir: dir });
  void openHost();
  return { ok: true };
});

handle("shell:connect", async (input) => {
  const url = normalizeServerUrl(String(input || ""));
  if (!url) return { ok: false, error: "这不像一个地址。填另一台设备上松果的地址，比如 192.168.1.20:7700" };
  if (!(await reachable(url))) return { ok: false, error: `连不上 ${url}。请确认那台设备上的松果正在运行，并且两台设备在同一个网络里。` };
  save({ mode: "client", serverUrl: url });
  origin = url;
  show(null);
  return { ok: true };
});

handle("shell:retry", () => void open());

// From any page of the window, the reader included: it only moves the window buttons.
ipcMain.on("shell:compact", (event, compact) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (mac && w && !w.isDestroyed()) w.setWindowButtonPosition(compact ? BUTTONS.compact : BUTTONS.wide);
});
handle("shell:choose", () => menuContext.chooseAgain());
handle("shell:show-log", () => menuContext.showLog());

// ───────────────────────── life of the app ─────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("web-contents-created", (_event, contents) => guard(contents));
  // macOS: the app stays in the Dock with its server running. Elsewhere it does so from the tray, if there is one.
  app.on("window-all-closed", () => {
    if (!mac && !(tray && settings.background && settings.mode === "host")) app.quit();
  });
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    rememberBounds();
    // let the server close its database before the process goes
    void stopServer().finally(() => app.quit());
  });

  void app.whenReady().then(() => {
    if (mac && !app.isPackaged) app.dock?.setIcon(ICON); // run from the repository: Electron's own icon otherwise
    app.setAboutPanelOptions({ applicationName: "松果 Acorn", applicationVersion: VERSION, version: "", copyright: "完全属于你的信息系统 · AGPL-3.0", website: "https://github.com/YongleEncyclopedia/acorn" });
    createTray();
    // started at login: stay out of the way, serving the phone and the tablet
    const hidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin;
    if (!hidden || settings.mode !== "host") win = createWindow();
    refreshMenus();
    void open();
  });
}
