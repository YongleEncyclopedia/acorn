/*
 * 标注: notes on the page for UI feedback (dev only; see vite.notes.config.ts).
 * Click an element, or drag over an area, and write what should change. A note keeps the element's selector, text,
 * a few computed styles, the page, the window size and the theme; notes are saved to tools/ui-notes/notes.json.
 * Everything lives in a shadow root: the app's styles and shortcuts do not reach it, and it does not reach them.
 */
(() => {
  if (window.__acornNotes) return;
  window.__acornNotes = true;

  const KINDS = ["样式", "文案", "交互", "布局", "问题", "其他"];
  let notes = [];
  let picking = false;
  let showPins = true;
  let editing = null; // { note, isNew }
  let listOpen = false;
  let hoverEl = null;
  let drag = null; // { x, y, region }

  // ───────── storage ─────────
  async function load() {
    try {
      notes = await (await fetch("/__notes", { cache: "no-store" })).json();
    } catch {
      notes = [];
    }
    render();
  }
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch("/__notes", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(notes) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        toast("已保存");
      } catch (e) {
        toast("保存失败：" + e.message, true);
      }
    }, 150);
  }

  // ───────── where things are ─────────
  const page = () => location.pathname + location.search;
  const ours = (e) => e.composedPath().includes(host);
  const stableClass = (c) => c && !/\d{3,}|^_|^css-|[A-Z0-9]{6,}/.test(c);

  function selectorOf(el) {
    if (!(el instanceof Element)) return "";
    const unique = (s) => {
      try {
        return document.querySelectorAll(s).length === 1;
      } catch {
        return false;
      }
    };
    if (el.id && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && unique("#" + CSS.escape(n.id))) {
        parts.unshift("#" + CSS.escape(n.id));
        break;
      }
      let part = n.tagName.toLowerCase();
      const cls = [...n.classList].filter(stableClass).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === n.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(part);
      if (n === document.body) break;
    }
    return parts.join(" > ");
  }
  const find = (sel) => {
    try {
      return sel ? document.querySelector(sel) : null;
    } catch {
      return null;
    }
  };
  const label = (el) => {
    if (!el) return "";
    const cls = [...el.classList].filter(stableClass).slice(0, 2).join(".");
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (text ? "「" + text + "」" : "");
  };
  const STYLES = ["font-family", "font-size", "font-weight", "line-height", "color", "background-color", "padding", "margin", "gap", "border-radius", "width", "height"];
  function context(el) {
    const cs = getComputedStyle(el);
    const html = el.outerHTML.replace(/\s(d|style|srcset)="[^"]{60,}"/g, ' $1="…"');
    return {
      selector: selectorOf(el),
      element: label(el),
      text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 300),
      html: html.length > 900 ? html.slice(0, 900) + "…" : html,
      styles: Object.fromEntries(STYLES.map((k) => [k, cs.getPropertyValue(k)])),
    };
  }
  /** Where a note is on screen now: its element (it follows scrolling panes), or the place it was made. */
  function placeOf(n) {
    const el = find(n.selector);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) {
        if (n.kind === "region" && n.offset) return { x: r.left + n.offset.x, y: r.top + n.offset.y, w: n.offset.w, h: n.offset.h, found: true };
        return { x: r.left, y: r.top, w: r.width, h: r.height, found: true };
      }
    }
    return { x: n.rect.x, y: n.rect.y, w: n.rect.w, h: n.rect.h, found: false };
  }

  // ───────── the overlay ─────────
  const host = document.createElement("div");
  host.setAttribute("data-acorn-notes", "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
  .bar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 6px; pointer-events: auto; background: #1f2328; color: #fff;
         padding: 6px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); font-size: 13px; }
  @media (max-width: 760px) { .bar { bottom: 78px; right: 10px; } }
  .bar button, .pop button { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; font-size: 13px; line-height: 1.2; }
  .bar button:hover { background: #3a4048; }
  .bar button.on { background: #e8590c; }
  .hover { position: fixed; border: 2px solid #e8590c; background: rgba(232,89,12,.08); border-radius: 3px; pointer-events: none; }
  .hover span { position: absolute; left: -2px; top: -22px; background: #e8590c; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
  .region { position: fixed; border: 2px dashed #e8590c; background: rgba(232,89,12,.10); pointer-events: none; }
  .pin { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #e8590c; color: #fff; font-size: 12px; font-weight: 600;
         display: grid; place-items: center; pointer-events: auto; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.3); border: 2px solid #fff; }
  .pin.done { background: #2f9e44; }
  .pin.lost { opacity: .45; }
  .pin:hover + .tip, .tip.show { display: block; }
  .tip { display: none; position: fixed; max-width: 280px; background: #1f2328; color: #fff; font-size: 12px; padding: 8px 10px; border-radius: 8px; pointer-events: none; white-space: pre-wrap; line-height: 1.5; }
  .mark { position: fixed; border: 1.5px solid rgba(232,89,12,.7); border-radius: 3px; pointer-events: none; }
  .mark.done { border-color: rgba(47,158,68,.7); }
  .pop { position: fixed; width: 320px; pointer-events: auto; background: #fff; color: #1f2328; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.28); padding: 12px; font-size: 13px; }
  .pop .head { font-size: 12px; color: #57606a; margin-bottom: 8px; word-break: break-all; }
  .pop .kinds { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .pop .kinds button { padding: 3px 9px; border: 1px solid #d0d7de; border-radius: 999px; font-size: 12px; }
  .pop .kinds button.on { background: #e8590c; border-color: #e8590c; color: #fff; }
  .pop textarea { width: 100%; min-height: 96px; resize: vertical; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; font-size: 14px; line-height: 1.5; outline: none; color: #1f2328; background: #fff; }
  .pop textarea:focus { border-color: #e8590c; }
  .pop .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; align-items: center; }
  .pop .row .grow { flex: 1; font-size: 11px; color: #8c959f; }
  .pop .primary { background: #e8590c; color: #fff; }
  .pop .ghost { color: #57606a; }
  .pop .danger { color: #cf222e; }
  .list { position: fixed; right: 16px; bottom: 70px; width: 360px; max-height: 60vh; overflow: auto; pointer-events: auto; background: #fff; color: #1f2328;
          border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.28); padding: 8px; font-size: 13px; }
  @media (max-width: 760px) { .list { right: 10px; left: 10px; width: auto; bottom: 132px; } }
  .list h4 { margin: 8px 6px 4px; font-size: 11px; color: #8c959f; font-weight: 500; word-break: break-all; }
  .list .item { display: flex; gap: 8px; padding: 8px 6px; border-radius: 8px; cursor: pointer; align-items: flex-start; }
  .list .item:hover { background: #f6f8fa; }
  .list .n { flex: none; width: 20px; height: 20px; border-radius: 50%; background: #e8590c; color: #fff; font-size: 11px; display: grid; place-items: center; font-weight: 600; }
  .list .n.done { background: #2f9e44; }
  .list .t { white-space: pre-wrap; line-height: 1.45; }
  .list .k { color: #8c959f; font-size: 11px; }
  .list .r { color: #2f9e44; font-size: 12px; line-height: 1.45; margin-top: 2px; white-space: pre-wrap; }
  .list .empty { padding: 16px; color: #8c959f; text-align: center; line-height: 1.6; }
  .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; pointer-events: none; }
  .toast.bad { background: #cf222e; }
  .hint { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); background: #e8590c; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; pointer-events: none; }
</style>
<div class="layer"></div>
<div class="bar">
  <button data-act="pick" title="点选一个元素，或拖出一块区域">✎ 标注</button>
  <button data-act="page" title="对整个页面写一条">整页</button>
  <button data-act="list">☰ <b class="count">0</b></button>
  <button data-act="pins" title="显示 / 隐藏页面上的标注">◉</button>
</div>`;
  const layer = root.querySelector(".layer");
  const bar = root.querySelector(".bar");
  // keys typed here are not the app's shortcuts (they would reach window otherwise, retargeted to the host)
  for (const t of ["keydown", "keyup", "keypress"]) root.addEventListener(t, (e) => e.stopPropagation());

  const pageStyle = document.createElement("style");
  pageStyle.textContent = "html.__notes-picking, html.__notes-picking * { cursor: crosshair !important; }";
  document.head.appendChild(pageStyle);

  function toast(text, bad) {
    const t = document.createElement("div");
    t.className = "toast" + (bad ? " bad" : "");
    t.textContent = text;
    root.appendChild(t);
    setTimeout(() => t.remove(), bad ? 4000 : 1200);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function setPicking(on) {
    picking = on;
    document.documentElement.classList.toggle("__notes-picking", on);
    if (!on) hoverEl = null;
    render();
  }

  // ───────── drawing ─────────
  let frame = 0;
  const render = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  function draw() {
    frame = 0;
    bar.querySelector('[data-act="pick"]').classList.toggle("on", picking);
    bar.querySelector('[data-act="pins"]').classList.toggle("on", !showPins);
    bar.querySelector(".count").textContent = String(notes.length);
    let html = "";
    if (picking && !editing) html += '<div class="hint">点选要改的元素，或按住拖出一块区域 · Esc 退出</div>';
    if (showPins) {
      for (const n of notes.filter((x) => x.page === page())) {
        const p = placeOf(n);
        const done = n.status === "done" ? " done" : "";
        html += `<div class="mark${done}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px"></div>`;
        html += `<div class="pin${done}${p.found ? "" : " lost"}" data-id="${n.id}" style="left:${p.x}px;top:${p.y}px">${n.n}</div>`;
        html += `<div class="tip" style="left:${Math.min(p.x + 14, innerWidth - 290)}px;top:${p.y + 14}px">${esc((n.category ? "【" + n.category + "】" : "") + n.note + (n.reply ? "\n\n✓ " + n.reply : ""))}</div>`;
      }
    }
    if (picking && !editing && hoverEl && !drag?.region) {
      const r = hoverEl.getBoundingClientRect();
      html += `<div class="hover" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"><span>${esc(label(hoverEl))}</span></div>`;
    }
    if (drag?.region) {
      const g = drag.region;
      html += `<div class="region" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px"></div>`;
    }
    layer.innerHTML = html;
    for (const pin of layer.querySelectorAll(".pin")) pin.addEventListener("click", () => openEditor(notes.find((n) => n.id === pin.dataset.id), false));
    drawEditor();
    drawList();
  }

  // ───────── the note editor ─────────
  let pop = null;
  // drawn at once rather than at the next frame: typing right after the click lands in the box
  const drawNow = () => {
    cancelAnimationFrame(frame);
    draw();
  };
  function openEditor(note, isNew) {
    editing = { note: { ...note }, isNew };
    pop?.remove();
    pop = null;
    drawNow();
  }
  function closeEditor() {
    editing = null;
    pop?.remove();
    pop = null;
    drawNow();
  }
  function drawEditor() {
    if (!editing) return;
    const n = editing.note;
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "pop";
      pop.innerHTML = `
        <div class="head">第 ${n.n} 条 · ${esc(n.kind === "page" ? "整个页面" : n.kind === "region" ? "一块区域" : n.element)}</div>
        <div class="kinds">${KINDS.map((k) => `<button data-k="${k}" class="${n.category === k ? "on" : ""}">${k}</button>`).join("")}</div>
        <textarea placeholder="这里要怎么改？哪里别扭、想要什么效果…"></textarea>
        <div class="row">
          <span class="grow">⌘↵ 保存 · Esc 取消</span>
          ${editing.isNew ? "" : '<button class="danger" data-act="delete">删除</button>'}
          <button class="ghost" data-act="cancel">取消</button>
          <button class="primary" data-act="save">保存</button>
        </div>`;
      const ta = pop.querySelector("textarea");
      ta.value = n.note || "";
      pop.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.k) {
          editing.note.category = editing.note.category === b.dataset.k ? "" : b.dataset.k;
          for (const x of pop.querySelectorAll("[data-k]")) x.classList.toggle("on", x.dataset.k === editing.note.category);
        } else if (b.dataset.act === "cancel") closeEditor();
        else if (b.dataset.act === "save") commit();
        else if (b.dataset.act === "delete") {
          notes = notes.filter((x) => x.id !== n.id);
          save();
          closeEditor();
        }
      });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeEditor();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
      });
      root.appendChild(pop);
      setTimeout(() => ta.focus(), 0);
      setTimeout(() => pop?.contains(root.activeElement) || ta.focus(), 150);
    }
    // next to what it is about, inside the window
    const p = n.kind === "page" ? { x: innerWidth / 2 - 160, y: innerHeight / 3, w: 0, h: 0 } : placeOf(n);
    const w = 320;
    const h = pop.offsetHeight || 220;
    let x = p.x + p.w + 12 + w < innerWidth ? p.x + p.w + 12 : p.x - w - 12;
    if (x < 8) x = Math.min(Math.max(8, p.x), innerWidth - w - 8);
    let y = Math.min(Math.max(8, p.y), innerHeight - h - 8);
    pop.style.left = x + "px";
    pop.style.top = y + "px";
  }
  function commit() {
    const ta = pop.querySelector("textarea");
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    const note = { ...editing.note, note: text, updatedAt: new Date().toISOString() };
    if (editing.isNew) notes.push(note);
    else notes = notes.map((x) => (x.id === note.id ? note : x));
    save();
    closeEditor();
  }

  function newNote(kind, el, rect) {
    const base = {
      id: Math.random().toString(36).slice(2, 10),
      n: notes.reduce((m, x) => Math.max(m, x.n), 0) + 1,
      kind,
      page: page(),
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      theme: document.documentElement.getAttribute("data-theme") || document.documentElement.className || "",
      category: "",
      note: "",
      status: "open",
      createdAt: new Date().toISOString(),
    };
    if (kind === "page") return { ...base, rect: { x: 0, y: 0, w: 0, h: 0 } };
    const ctx = context(el);
    const r = el.getBoundingClientRect();
    if (kind === "region") return { ...base, ...ctx, rect, offset: { x: rect.x - r.left, y: rect.y - r.top, w: rect.w, h: rect.h } };
    return { ...base, ...ctx, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }

  // ───────── the list ─────────
  let listEl = null;
  function drawList() {
    if (!listOpen) {
      listEl?.remove();
      listEl = null;
      return;
    }
    if (!listEl) {
      listEl = document.createElement("div");
      listEl.className = "list";
      listEl.addEventListener("click", (e) => {
        const item = e.target.closest(".item");
        if (!item) return;
        const n = notes.find((x) => x.id === item.dataset.id);
        if (!n) return;
        if (n.page !== page()) {
          history.pushState(null, "", n.page);
          dispatchEvent(new PopStateEvent("popstate"));
        }
        setTimeout(() => {
          const el = find(n.selector);
          el?.scrollIntoView({ block: "center", behavior: "smooth" });
          setTimeout(() => openEditor(n, false), 350);
        }, 400);
      });
      root.appendChild(listEl);
    }
    const pages = [...new Set(notes.map((n) => n.page))];
    listEl.innerHTML = notes.length
      ? pages
          .map(
            (p) =>
              `<h4>${esc(p)}${p === page() ? "（当前页）" : ""}</h4>` +
              notes
                .filter((n) => n.page === p)
                .map(
                  (n) =>
                    `<div class="item" data-id="${n.id}"><div class="n${n.status === "done" ? " done" : ""}">${n.n}</div><div><div class="t">${esc(n.note)}</div>${n.reply ? `<div class="r">✓ ${esc(n.reply)}</div>` : ""}<div class="k">${esc([n.category, n.kind === "page" ? "整页" : n.element, n.viewport.w <= 760 ? "手机宽度" : "", n.status === "done" ? "已改" : ""].filter(Boolean).join(" · "))}</div></div></div>`,
                )
                .join(""),
          )
          .join("")
      : '<div class="empty">还没有标注。<br>点「✎ 标注」，再点页面上要改的地方。</div>';
  }

  // ───────── the toolbar ─────────
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "pick") setPicking(!picking);
    if (b.dataset.act === "page") openEditor(newNote("page"), true);
    if (b.dataset.act === "list") {
      listOpen = !listOpen;
      render();
    }
    if (b.dataset.act === "pins") {
      showPins = !showPins;
      render();
    }
  });

  // ───────── picking: the app gets none of these events meanwhile ─────────
  // the click that follows the press which opened the editor still belongs to the overlay (a link would navigate)
  let swallowUntil = 0;
  const block = (e) => {
    if (ours(e)) return false;
    if (Date.now() < swallowUntil && /^(mouse(down|up)|click|dblclick|auxclick)$/.test(e.type)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "click") pop?.querySelector("textarea")?.focus();
      return true;
    }
    if (!picking || editing) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  addEventListener(
    "pointermove",
    (e) => {
      if (!picking || editing || ours(e)) return;
      if (drag) {
        const x = Math.min(drag.x, e.clientX);
        const y = Math.min(drag.y, e.clientY);
        const w = Math.abs(e.clientX - drag.x);
        const h = Math.abs(e.clientY - drag.y);
        if (drag.region || w > 6 || h > 6) drag.region = { x, y, w, h };
      } else hoverEl = document.elementFromPoint(e.clientX, e.clientY);
      render();
    },
    true,
  );
  addEventListener(
    "pointerdown",
    (e) => {
      if (block(e)) drag = { x: e.clientX, y: e.clientY, region: null };
    },
    true,
  );
  addEventListener(
    "pointerup",
    (e) => {
      if (!block(e) || !drag) return;
      const d = drag;
      drag = null;
      swallowUntil = Date.now() + 600;
      if (d.region && d.region.w > 6 && d.region.h > 6) {
        // anchored to what is under the middle of the area, so it follows that pane when it scrolls
        host.style.display = "none";
        const anchor = document.elementFromPoint(d.region.x + d.region.w / 2, d.region.y + d.region.h / 2) || document.body;
        host.style.display = "";
        openEditor(newNote("region", anchor, d.region), true);
      } else {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== document.documentElement) openEditor(newNote("element", el), true);
      }
    },
    true,
  );
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "auxclick"]) addEventListener(t, block, true);
  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && picking && !editing) {
        e.stopImmediatePropagation();
        setPicking(false);
      }
    },
    true,
  );

  // pins follow scrolling panes, resizing and the app's own navigation
  addEventListener("scroll", render, true);
  addEventListener("resize", render);
  addEventListener("popstate", render);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      render();
      return r;
    };
  }
  setInterval(render, 500);

  (document.body || document.documentElement).appendChild(host);
  load();
})();
