import { Fragment } from "react";
import { Dialog } from "./Dialog.tsx";
import { ui } from "../lib/store.ts";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Words between keys ("G 然后 T", "⌘ K 或 /"); everything else in a combination is a key cap. */
const JOINERS = new Set(["然后", "或", "+"]);

/**
 * Every keyboard shortcut, in the order a reader meets them. The sheet (?) and the settings page both render
 * this list; the handlers themselves live next to what they act on (StreamPage, EntryReader, App).
 */
export const SHORTCUTS: { group: string; items: { keys: string[]; does: string }[] }[] = [
  {
    group: "翻阅",
    items: [
      { keys: ["J"], does: "下一篇" },
      { keys: ["K"], does: "上一篇" },
      { keys: ["空格"], does: "向下翻一屏，读到底就进入下一篇" },
      { keys: ["Shift", "+", "空格"], does: "向上翻一屏" },
      { keys: ["Esc"], does: "合上文章，回到列表" },
      { keys: ["R"], does: "刷新列表" },
      { keys: ["Shift", "+", "A"], does: "把列表全部标为已读" },
    ],
  },
  {
    group: "这篇文章",
    items: [
      { keys: ["S"], does: "稍后读（并自动入藏）" },
      { keys: ["A"], does: "入藏到本地" },
      { keys: ["M"], does: "标为已读 / 未读" },
      { keys: ["F"], does: "抓取全文 / 切换订阅源原始内容" },
      { keys: ["T"], does: "翻译 / 关闭翻译" },
      { keys: ["I"], does: "要点（AI 提炼）" },
      { keys: ["H"], does: "本文批注" },
      { keys: ["V"], does: "打开原文" },
      { keys: ["Z"], does: "专注阅读：收起侧栏和列表" },
    ],
  },
  {
    group: "去别处",
    items: [
      { keys: [MOD, "+", "K", "或", "/"], does: "搜索，或者输入订阅源的名字、要做的事" },
      { keys: ["G", "然后", "T"], does: "今日" },
      { keys: ["G", "然后", "U"], does: "未读" },
      { keys: ["G", "然后", "S"], does: "稍后读" },
      { keys: ["G", "然后", "A"], does: "藏" },
      { keys: ["G", "然后", "N"], does: "批注" },
      { keys: ["?"], does: "显示这张快捷键表" },
    ],
  },
];

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) => (
        <Fragment key={i}>{JOINERS.has(k) ? <span className="join">{k}</span> : <kbd>{k}</kbd>}</Fragment>
      ))}
    </span>
  );
}

export function ShortcutList() {
  return (
    <div className="shortcuts">
      {SHORTCUTS.map((g) => (
        <section key={g.group}>
          <h3>{g.group}</h3>
          <dl>
            {g.items.map((it) => (
              <div key={it.does}>
                <dt>{it.does}</dt>
                <dd>
                  <Keys keys={it.keys} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The sheet behind the ? key. */
export function ShortcutSheet() {
  const open = ui.use((s) => s.shortcuts);
  if (!open) return null;
  return (
    <Dialog title="键盘快捷键" size="lg" onClose={() => ui.set({ shortcuts: false })}>
      <ShortcutList />
    </Dialog>
  );
}
