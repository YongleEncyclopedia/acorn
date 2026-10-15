# 插件：把任何网站变成订阅源

`plugins/` 目录里的每个 `.ts` 文件就是一个插件。松果会在文件变化时自动重新加载，不需要重启。
文件名以 `_` 开头的会被忽略，适合放草稿。

```ts
import type { AcornPlugin } from "../src/server/feeds/plugin-api.ts";

const plugin: AcornPlugin = {
  id: "my-source",                 // 唯一 id，订阅时用它
  name: "我的来源",
  description: "一句话说明",
  params: [{ key: "url", label: "列表页地址", required: true }],
  async fetch(ctx) {
    const html = await ctx.fetchText(ctx.params.url);
    const { document } = ctx.parseHTML(html);
    return {
      title: "我的来源",
      items: [...document.querySelectorAll(".item")].map((el) => ({
        title: el.querySelector("a")?.textContent?.trim() || "",
        url: ctx.absolutize(el.querySelector("a")?.getAttribute("href"), ctx.params.url),
        publishedAt: el.querySelector(".date")?.textContent,   // "2026-10-13"、"10-13"、"3小时前" 都可以
        content: el.querySelector(".summary")?.innerHTML,       // 可选，HTML 会被净化
      })),
    };
  },
};
export default plugin;
```

`ctx` 提供：`params`、`fetchText(url, { headers, referer, cookie })`、`fetchJson`、`parseHTML`（linkedom）、
`absolutize`、`parseDate`、`log`。

订阅：网页界面「添加订阅 → 插件」，或者 `acorn add plugin:my-source`，或者 MCP 工具 `add_feed`（`kind: "plugin"`）。

调试：`acorn preview my-source --kind plugin`，日志在「设置 → 数据 → 运行日志」。

示例：`plugins/hn-best.ts`（JSON API）、`plugins/web-list.ts`（带分页的通知列表）。

## 什么时候不需要插件

- 有 RSS 的网站：直接订阅。
- 单页的通知列表：用「网页」类型，松果会自动识别列表，必要时手动改选择器。
- 正文提取不准：在订阅源设置 → 高级里填「正文选择器」，或者在 `src/server/content/rules/` 加一条站点规则。
