// The shell's own page (see ../main.ts): it asks the app what to show — starting, the first-run choice, or what
// went wrong — and sends back what the user decided. Plain DOM: three small screens do not need a framework.
const shell = window.acornShell;
const root = document.getElementById("root");

const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 6.4c-.2-1.8.5-3.2 2-4.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M7.3 14.6C7.3 9.7 11.2 6.6 16 6.6s8.7 3.1 8.7 8z" fill="currentColor"/>
  <rect x="6.2" y="13.6" width="19.6" height="2.6" rx="1.3" fill="currentColor"/>
  <path d="M8.6 16.2c0 6.3 3.4 10.3 7.4 11.6 4-1.3 7.4-5.3 7.4-11.6z" fill="currentColor" fill-opacity=".55"/>
</svg>`;

/** h("button.primary", { onclick }, "开始使用") — an element with classes, properties and children. */
function h(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  Object.assign(el, props);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function header(title, lede) {
  const logo = h("div");
  logo.innerHTML = LOGO; // a constant of this file, not data
  return [logo.firstElementChild, h("h1", {}, title), lede && h("p.lede", {}, lede)];
}

function starting(state) {
  return h("div.stack", {}, header("松果"), h("div.spinner", { role: "status" }), h("p.lede", {}, state.view.message || "正在启动…"));
}

function welcome(state) {
  let dataDir = state.dataDir;
  const path = h("bdi", {}, dataDir);
  const note = h("p.note", { hidden: !state.hasLibrary }, "这里已经有一个松果的库，会接着用它。");
  const hostError = h("p.error", { hidden: true });
  const start = h("button.primary", {}, "开始使用");
  start.onclick = async () => {
    start.disabled = true;
    const r = await shell.host(dataDir);
    if (r && !r.ok) {
      hostError.textContent = r.error;
      hostError.hidden = false;
      start.disabled = false;
    }
  };
  const change = h("button.quiet", {}, "换个位置…");
  change.onclick = async () => {
    const picked = await shell.pickFolder();
    if (!picked) return;
    dataDir = picked.dir;
    path.textContent = dataDir;
    note.hidden = !picked.hasLibrary;
  };

  const address = h("input", { type: "text", placeholder: "192.168.1.20:7700 或 http://…", value: state.serverUrl || "", spellcheck: false, autocapitalize: "off" });
  const connectError = h("p.error", { hidden: true });
  const connect = h("button", {}, "连接");
  const tryConnect = async () => {
    if (!address.value.trim()) return address.focus();
    connect.disabled = true;
    connect.textContent = "正在连接…";
    connectError.hidden = true;
    const r = await shell.connect(address.value);
    if (r && !r.ok) {
      connectError.textContent = r.error;
      connectError.hidden = false;
      connect.disabled = false;
      connect.textContent = "连接";
    }
  };
  connect.onclick = tryConnect;
  address.onkeydown = (e) => e.key === "Enter" && !e.isComposing && tryConnect();

  return h(
    "div.stack",
    {},
    header("松果", "完全属于你的信息系统。先决定这一件事：松果的库放在哪台设备上。"),
    h(
      "div.choices",
      {},
      h(
        "section.choice",
        {},
        h("h2", {}, "安在这台电脑上"),
        h("p", {}, "订阅、文章和存档都保存在这台电脑；手机、平板和别的电脑连到这里来读。松果开着的时候，它会一直替你更新订阅。"),
        h("div.row", {}, h("div.path", { title: "数据位置" }, path), change, start),
        note,
        hostError,
      ),
      h(
        "section.choice",
        {},
        h("h2", {}, "连接已有的松果"),
        h("p", {}, "松果已经在另一台电脑或 NAS 上运行，这里只是它的一个窗口。填那台设备上松果的地址。"),
        h("div.row", {}, address, connect),
        connectError,
      ),
    ),
    h("p.foot", {}, `松果 Acorn ${state.version} · 以后可以在菜单「更换数据位置或连接其他松果」里改`),
  );
}

function failed(state) {
  return h(
    "div.stack",
    {},
    header("没能打开松果", state.view.message || "出了点问题。"),
    state.view.detail && h("pre.detail", {}, state.view.detail),
    h(
      "div.actions",
      {},
      h("button.primary", { onclick: () => shell.retry() }, "再试一次"),
      h("button", { onclick: () => shell.choose() }, "更换数据位置或连接方式"),
      h("button.quiet", { onclick: () => shell.showLog() }, "查看日志"),
    ),
  );
}

const state = await shell.state();
document.documentElement.dataset.platform = state.platform;
root.replaceChildren(state.view.name === "welcome" ? welcome(state) : state.view.name === "error" ? failed(state) : starting(state));
