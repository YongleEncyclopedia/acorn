import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseFeedText, NotAFeedError } from "../src/server/feeds/parse.ts";
import { scrapeList, suggestRule } from "../src/server/feeds/html-source.ts";
import { discoverFeeds } from "../src/server/feeds/discover.ts";
import { parseRsshubInput, rsshubUrl } from "../src/server/feeds/rsshub.ts";

const fx = (f: string) => readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8");

describe("parseFeedText", () => {
  it("parses Atom", () => {
    const f = parseFeedText(fx("atom.xml"), "https://www.ruanyifeng.com/blog/atom.xml");
    expect(f.format).toBe("atom");
    expect(f.title).toBe("阮一峰的网络日志");
    expect(f.items.length).toBeGreaterThan(0);
    expect(f.items[0].url).toMatch(/^http/);
    expect(f.items[0].publishedAt).toBeGreaterThan(0);
    expect(f.items[0].contentHtml).toContain("<p>");
  });
  it("parses RSS with dc:creator and guid", () => {
    const f = parseFeedText(fx("rss.xml"), "https://hnrss.org/frontpage");
    expect(f.format).toBe("rss");
    expect(f.items[0].guid).toMatch(/news\.ycombinator\.com/);
    expect(f.items[0].author).toBeTruthy();
  });
  it("parses JSON Feed", () => {
    const f = parseFeedText(fx("feed.json"), "https://www.jsonfeed.org/feed.json");
    expect(f.format).toBe("json");
    expect(f.items[0].title).toBe("JSON Feed version 1.1");
  });
  it("rejects web pages", () => {
    expect(() => parseFeedText(fx("edu-list.html"), "https://x/")).toThrow(NotAFeedError);
  });
});

describe("HTML list pages", () => {
  const url = "https://jwc.sjtu.edu.cn/xwtg/tztg.htm";
  it("auto-detects the article list and the split date widget", () => {
    const rule = suggestRule(fx("edu-list.html"), url)!;
    expect(rule.item).toBe("div.Newslist > ul > li.clearfix");
    expect(rule.date).toBe("div.sj");
  });
  it("scrapes titles, absolute links and dates", () => {
    const items = scrapeList(fx("edu-list.html"), url, { item: "div.Newslist > ul > li.clearfix", date: "div.sj" });
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items[0].url).toMatch(/^https:\/\/jwc\.sjtu\.edu\.cn\/info\//);
    expect(new Date(items[0].publishedAt!).getFullYear()).toBe(2026);
    expect(items.every((i) => i.title.length > 4)).toBe(true);
  });
});

describe("discovery and RSSHub", () => {
  it("finds alternate feeds", () => {
    const c = discoverFeeds('<html><head><link rel="alternate" type="application/rss+xml" title="RSS" href="/feed"></head></html>', "https://sspai.com/");
    expect(c[0]).toMatchObject({ url: "https://sspai.com/feed", title: "RSS" });
  });
  it("parses and resolves routes", () => {
    expect(parseRsshubInput("rsshub://bilibili/user/dynamic/2267573")).toBe("/bilibili/user/dynamic/2267573");
    expect(parseRsshubInput("https://rsshub.app/zhihu/hot?key=secret")).toBe("/zhihu/hot");
    expect(parseRsshubInput("https://my.hub/weibo/search/hot", ["https://my.hub"])).toBe("/weibo/search/hot");
    expect(rsshubUrl("/zhihu/hot", "http://localhost:1200/", "k")).toBe("http://localhost:1200/zhihu/hot?key=k");
  });
});

describe("lists where each entry is one link", () => {
  const html = `<html><body><nav><a href="/">首页</a></nav><div class="announcement-list">${Array.from({ length: 5 }, (_, i) =>
    `<a href="/post/${i}" class="announcement-item"><div class="calendar-box"><div class="day">09.${10 + i}</div><div class="month">2025</div></div><div class="text-box"><div class="title">第${i + 1}个测试通知的完整标题</div><div class="desc"></div></div></a>`).join("")}</div></body></html>`;
  it("finds the entries, their titles without the date, and the year from the date widget", () => {
    const rule = suggestRule(html, "https://gs.example.edu/announcement")!;
    expect(rule.item).toBe("div.announcement-list > a.announcement-item");
    const items = scrapeList(html, "https://gs.example.edu/announcement", rule);
    expect(items).toHaveLength(5);
    expect(items[0].title).toBe("第1个测试通知的完整标题");
    expect(items[0].url).toBe("https://gs.example.edu/post/0");
    expect(new Date(items[0].publishedAt!).toLocaleDateString("en-CA")).toBe("2025-09-10");
  });
});
