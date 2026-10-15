/**
 * Example plugin: Hacker News "best" stories through the official Firebase API (a JSON API, not RSS).
 * Shows the plugin shape: default-export an AcornPlugin with id, name, params and fetch(ctx).
 * Copy this file to make your own; Acorn hot-reloads plugins when files change.
 */
import type { AcornPlugin } from "../src/server/feeds/plugin-api.ts";

interface Story {
  id: number;
  title: string;
  url?: string;
  by: string;
  time: number;
  score: number;
  descendants?: number;
  text?: string;
}

const plugin: AcornPlugin = {
  id: "hn-best",
  name: "Hacker News 精选",
  description: "Hacker News best 榜单，按分数过滤。演示如何把任意 JSON API 变成订阅源。",
  params: [{ key: "minScore", label: "最低分数", placeholder: "200" }],
  async fetch(ctx) {
    const minScore = Number(ctx.params.minScore || 200);
    const ids = (await ctx.fetchJson<number[]>("https://hacker-news.firebaseio.com/v0/beststories.json")).slice(0, 40);
    const stories = await Promise.all(ids.map((id) => ctx.fetchJson<Story>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)));
    return {
      title: "Hacker News 精选",
      siteUrl: "https://news.ycombinator.com/best",
      items: stories
        .filter((s): s is Story => !!s && s.score >= minScore)
        .map((s) => ({
          guid: `hn-${s.id}`,
          title: s.title,
          url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
          author: s.by,
          publishedAt: s.time * 1000,
          content: `${s.text ? `<p>${s.text}</p>` : ""}<p>${s.score} points · <a href="https://news.ycombinator.com/item?id=${s.id}">${s.descendants ?? 0} 条评论</a></p>`,
        })),
    };
  },
};

export default plugin;
