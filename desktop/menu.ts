/**
 * The desktop app's menus: the menu bar, the right-click menu of the page, and the tray menu on Windows and
 * Linux. Menu items do not reach into the reader; they send it a command, the same ones a key press would give.
 */
import { clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

export const REPO_URL = "https://github.com/YongleEncyclopedia/acorn";

export interface MenuContext {
  /** Tell the reader in the window to do something ("go:/settings", "add-source"…). */
  command: (command: string) => void;
  /** Whether the window is showing the reader (and not the welcome page). */
  reading: () => boolean;
  mode: () => "host" | "client" | null;
  /** Addresses other devices can open, when this computer keeps the library. */
  addresses: () => string[];
  showWindow: () => void;
  showData: () => void;
  showLog: () => void;
  /** Back to the welcome page: keep the library elsewhere, or connect to another Acorn. */
  chooseAgain: () => void;
  /** null where the system has no such thing (Linux). */
  loginItem: { get: () => boolean; set: (on: boolean) => void } | null;
  /** Windows / Linux: keep running in the tray after the window is closed. */
  background: { get: () => boolean; set: (on: boolean) => void } | null;
  quit: () => void;
}

type Item = MenuItemConstructorOptions;
const sep: Item = { type: "separator" };

function addressItems(ctx: MenuContext): Item[] {
  const list = ctx.addresses();
  if (!list.length) return [{ label: ctx.mode() === "client" ? "这台电脑连接的是别处的松果" : "没有找到局域网地址", enabled: false }];
  return list.map((url) => ({ label: `${url}　复制`, click: () => clipboard.writeText(url) }));
}

export function buildAppMenu(ctx: MenuContext): Menu {
  const mac = process.platform === "darwin";
  const reading = ctx.reading();
  const go = (label: string, path: string, accelerator?: string): Item => ({ label, accelerator, enabled: reading, click: () => ctx.command(`go:${path}`) });
  const settings: Item = { label: "设置…", accelerator: "CmdOrCtrl+,", enabled: reading, click: () => ctx.command("go:/settings") };
  const library: Item[] = [
    { label: "其他设备访问这台电脑的地址", submenu: addressItems(ctx) },
    { label: "扫码在手机上登录…", enabled: reading, click: () => ctx.command("go:/settings#devices") },
    sep,
    { label: mac ? "在访达中显示数据文件夹" : "打开数据文件夹", enabled: ctx.mode() === "host", click: ctx.showData },
    { label: "更换数据位置或连接其他松果…", click: ctx.chooseAgain },
    ...(ctx.loginItem ? [sep, { label: "开机时启动", type: "checkbox" as const, checked: ctx.loginItem.get(), click: (item: { checked: boolean }) => ctx.loginItem!.set(item.checked) }] : []),
    ...(ctx.background ? [{ label: "关闭窗口后继续在后台更新", type: "checkbox" as const, checked: ctx.background.get(), click: (item: { checked: boolean }) => ctx.background!.set(item.checked) }] : []),
  ];

  const template: Item[] = [
    ...(mac
      ? [
          {
            label: "松果",
            submenu: [
              { label: "关于松果", role: "about" as const },
              sep,
              settings,
              sep,
              ...library,
              sep,
              { label: "服务", role: "services" as const },
              sep,
              { label: "隐藏松果", role: "hide" as const },
              { label: "隐藏其他", role: "hideOthers" as const },
              { label: "全部显示", role: "unhide" as const },
              sep,
              { label: "退出松果", accelerator: "Cmd+Q", click: ctx.quit },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "添加订阅…", accelerator: "CmdOrCtrl+N", enabled: reading, click: () => ctx.command("add-source") },
        { label: "入藏一个网址…", accelerator: "CmdOrCtrl+Shift+N", enabled: reading, click: () => ctx.command("go:/archive?capture=1") },
        { label: "刷新全部订阅源", accelerator: "CmdOrCtrl+Shift+R", enabled: reading, click: () => ctx.command("refresh-all") },
        sep,
        ...(mac ? [{ label: "关闭窗口", role: "close" as const }] : [settings, sep, ...library, sep, { label: "退出", accelerator: "Ctrl+Q", click: ctx.quit }]),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        sep,
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
        sep,
        { label: "搜索…", accelerator: "CmdOrCtrl+F", enabled: reading, click: () => ctx.command("palette") },
      ],
    },
    {
      label: "显示",
      submenu: [
        go("今日", "/s/today", "CmdOrCtrl+1"),
        go("未读", "/s/unread", "CmdOrCtrl+2"),
        go("稍后读", "/s/starred", "CmdOrCtrl+3"),
        go("藏", "/archive", "CmdOrCtrl+4"),
        go("批注", "/notes", "CmdOrCtrl+5"),
        go("订阅管理", "/sources", "CmdOrCtrl+6"),
        sep,
        { label: "专注阅读", accelerator: "CmdOrCtrl+Shift+F", enabled: reading, click: () => ctx.command("focus") },
        sep,
        { label: "重新载入", role: "reload" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        sep,
        { label: "切换全屏", role: "togglefullscreen" },
      ],
    },
    { label: "窗口", role: "windowMenu" },
    {
      label: "帮助",
      role: "help",
      submenu: [
        { label: "键盘快捷键", enabled: reading, click: () => ctx.command("shortcuts") },
        sep,
        { label: "查看运行日志", click: ctx.showLog },
        { label: "检查新版本…", click: () => void shell.openExternal(`${REPO_URL}/releases`) },
        { label: "松果的 GitHub 主页", click: () => void shell.openExternal(REPO_URL) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

export function buildTrayMenu(ctx: MenuContext): Menu {
  return Menu.buildFromTemplate([
    { label: "打开松果", click: ctx.showWindow },
    { label: "其他设备访问这台电脑的地址", submenu: addressItems(ctx) },
    sep,
    { label: "退出", click: ctx.quit },
  ]);
}

/**
 * A page inside Electron has no right-click menu of its own. Offer what a reader expects: copy and paste in
 * text and fields, the link under the pointer, the picture under it. (The reader's own menus — on a list entry —
 * take the event first and this one never shows there.)
 */
export function popupContextMenu(win: BrowserWindow, p: ContextMenuParams): void {
  const items: Item[] = [];
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    items.push({ label: "在浏览器中打开链接", click: () => void shell.openExternal(p.linkURL) }, { label: "复制链接地址", click: () => clipboard.writeText(p.linkURL) });
  }
  if (p.mediaType === "image" && p.srcURL) {
    if (items.length) items.push(sep);
    items.push({ label: "复制图片", click: () => win.webContents.copyImageAt(p.x, p.y) }, { label: "图片存储为…", click: () => win.webContents.downloadURL(p.srcURL) });
  }
  if (p.isEditable) {
    if (items.length) items.push(sep);
    items.push({ label: "剪切", role: "cut", enabled: p.editFlags.canCut }, { label: "复制", role: "copy", enabled: p.editFlags.canCopy }, { label: "粘贴", role: "paste", enabled: p.editFlags.canPaste }, sep, { label: "全选", role: "selectAll" });
  } else if (p.selectionText.trim()) {
    if (items.length) items.push(sep);
    items.push({ label: "复制", role: "copy" });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}
