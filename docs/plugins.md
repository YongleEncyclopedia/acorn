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

`ctx` 提供：`params`、`fetchText(url, { headers, referer, cookie })`、`fetchJson`、`request`（不因错误状态码抛错，
带响应头，适合翻页和判断登录失效）、`parseHTML`（linkedom）、`absolutize`、`parseDate`、`log`。

参数可以是下拉选项：`options: [{ value, label }]`；也可以从账号里读可选项（比如你加入的星球）：设 `fromAccount: true`，
再实现 `choices(ctx, key)`。

### 要登录的平台

插件声明 `account: "<平台 id>"` 后，会拿到「设置 → 账号」里那份登录：`ctx.account` 有 `origin`、`token`、`cookie`，
跨站单点登录的还有 `jar`（按域名分的 Cookie）。平台不再接受登录时调用 `ctx.loginExpired("说明")`：账号会标成
「登录已过期」，订阅源提示用户重新登录，而不是一遍遍重试。平台本身（登录方式、检查登录的 `whoami`、请求头）登记在
`src/server/accounts/services.ts`；内置的知识星球、Canvas、交我办在 `src/server/feeds/builtin/`，可以照着写。

订阅：网页界面「添加订阅 → 插件」，或者 `acorn add plugin:my-source`，或者 MCP 工具 `add_feed`（`kind: "plugin"`）。

调试：`acorn preview my-source --kind plugin`，日志在「设置 → 数据 → 运行日志」。

示例：`plugins/hn-best.ts`（JSON API）、`plugins/web-list.ts`（带分页的通知列表）。

## 什么时候不需要插件

- 有 RSS 的网站：直接订阅。
- 单页的通知列表：用「网页」类型，松果会自动识别列表，必要时手动改选择器。
- 正文提取不准：在订阅源设置 → 高级里填「正文选择器」，或者在 `src/server/content/rules/` 加一条站点规则。
