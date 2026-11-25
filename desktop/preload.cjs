// The one bridge between the desktop shell and what its window shows. It is loaded into every page of the
// window, the reader included, so it hands out very little: the platform, commands coming from the app's menus,
// and — for the shell's own welcome page only, the main process checks who is asking — the first-run choices.
// (CommonJS: a sandboxed preload script cannot be an ES module.)
const { contextBridge, ipcRenderer } = require("electron");

let onCommand = null;
ipcRenderer.on("shell:command", (_event, command) => {
  if (onCommand) onCommand(String(command));
});

// In full screen the window buttons are gone and the reader takes back the room it kept for them (app.css).
ipcRenderer.on("shell:fullscreen", (_event, on) => {
  if (document.documentElement) document.documentElement.toggleAttribute("data-shell-fullscreen", !!on);
});

// Narrower than 980px the reader's bars grow a strip on top for the window buttons (app.css); the app moves the
// buttons into it. The media query is the page's own, so zooming the page is taken into account.
const compact = window.matchMedia("(max-width: 980px)");
const sendLayout = () => ipcRenderer.send("shell:compact", compact.matches);
compact.addEventListener("change", sendLayout);
sendLayout();

contextBridge.exposeInMainWorld("acornShell", {
  platform: process.platform,
  /** The reader registers one listener for menu commands ("go:/settings", "add-source"…). */
  onCommand: (fn) => {
    onCommand = typeof fn === "function" ? fn : null;
  },
  // ---- welcome page ----
  state: () => ipcRenderer.invoke("shell:state"),
  pickFolder: () => ipcRenderer.invoke("shell:pick-folder"),
  host: (dataDir) => ipcRenderer.invoke("shell:host", dataDir),
  connect: (url) => ipcRenderer.invoke("shell:connect", url),
  retry: () => ipcRenderer.invoke("shell:retry"),
  choose: () => ipcRenderer.invoke("shell:choose"),
  showLog: () => ipcRenderer.invoke("shell:show-log"),
});
