/**
 * Example plugin: a list page that needs more than CSS selectors — here, pagination across several pages.
 * Many department sites split notices over list.htm, list2.htm, list3.htm…; this follows "下一页" links.
 * For a single page, the built-in "网页" source type is simpler (no code needed).
 */
import type { AcornPlugin } from "../src/server/feeds/plugin-api.ts";

const plugin: AcornPlugin = {
  id: "web-list-paged",
  name: "分页网页列表",
  description: "抓取带分页的通知列表：给出列表页地址和条目选择器，自动跟随「下一页」链接。",
  params: [
    { key: "url", label: "列表页地址", required: true, placeholder: "https://example.edu.cn/tzgg.htm" },
    { key: "item", label: "条目选择器", required: true, placeholder: ".news_list li" },
    { key: "pages", label: "最多翻几页", placeholder: "3" },
  ],
  async fetch(ctx) {
    const pages = Math.min(Number(ctx.params.pages || 3), 10);
    let url: string | null = ctx.params.url;
    let title = "";
    const items = [];
    for (let i = 0; i < pages && url; i += 1) {
      const html = await ctx.fetchText(url);
      const { document } = ctx.parseHTML(html);
      if (!title) title = document.querySelector("title")?.textContent?.trim() || url;
      for (const row of document.querySelectorAll(ctx.params.item)) {
        const a = row.querySelector("a[href]");
        const link = ctx.absolutize(a?.getAttribute("href"), url);
        const text = (a?.getAttribute("title") || a?.textContent || "").trim();
        if (!link || !text) continue;
        const date = (row.textContent || "").match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0];
        items.push({ title: text, url: link, publishedAt: date || null });
      }
      const next = [...document.querySelectorAll("a[href]")].find((x) => /下一页|下页|next/i.test(x.textContent || ""));
      url = next ? ctx.absolutize(next.getAttribute("href"), url) : null;
    }
    ctx.log(`collected ${items.length} items`);
    return { title, siteUrl: ctx.params.url, items };
  },
};

export default plugin;
