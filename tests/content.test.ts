import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitize } from "../src/server/content/sanitize.ts";
import { extractArticle, cleanSiteName } from "../src/server/content/extract.ts";
import { detectBlocked, detectGone } from "../src/server/content/rules/index.ts";
import { parseMhtml } from "../src/server/archive/mhtml.ts";
import { toMarkdown } from "../src/server/content/markdown.ts";

const fx = (f: string) => readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8");

describe("sanitize", () => {
  it("removes scripts, handlers and javascript: links", () => {
    const out = sanitize('<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>', "https://e.com/");
    expect(out).not.toMatch(/script|onclick|javascript/);
  });
  it("resolves lazy images and relative URLs, fixes double-encoded ampersands", () => {
    const out = sanitize('<img data-src="/a.jpg?x=1&amp;amp;y=2" src="data:image/gif;base64,R0lGOD"><a href="b.html">b</a>', "https://e.com/dir/");
    expect(out).toContain('src="https://e.com/a.jpg?x=1&amp;y=2"');
    expect(out).toContain('href="https://e.com/dir/b.html"');
  });
  it("only allows known video embeds", () => {
    expect(sanitize('<iframe src="https://player.bilibili.com/player.html?bvid=1"></iframe>')).toContain("player.bilibili.com");
    expect(sanitize('<iframe src="https://evil.example/x"></iframe>')).not.toContain("evil");
  });
  it("drops tracking pixels, placeholders and avatars", () => {
    const out = sanitize('<img src="https://e.com/p.gif" width="1" height="1"><img src="https://cdn.e.com/ui/img-placeholder.png"><img src="https://e.com/avatar/u.jpg"><img src="https://e.com/real.jpg">');
    expect(out).toBe('<img src="https://e.com/real.jpg" />');
  });
});

describe("extractArticle", () => {
  it("uses the sspai rule for the article body", () => {
    const a = extractArticle(fx("sspai-article.html"), "https://sspai.com/post/114561")!;
    expect(a.rule).toBe("sspai");
    expect(a.siteName).toBe("少数派");
    expect(a.text.startsWith("Matrix 首页推荐")).toBe(true);
    expect(a.text).not.toContain("19 分钟阅读");
    expect(a.wordCount).toBeGreaterThan(3000);
  });
  it("finds the body of a university CMS page", () => {
    const a = extractArticle(fx("edu-article.html"), "https://jwc.sjtu.edu.cn/info/1222/129051.htm")!;
    expect(a.text).toContain("各位同学");
    expect(a.text).toContain("注意事项");
  });
  it("cleans site names", () => {
    expect(cleanSiteName("少数派 - 高品质数字消费指南")).toBe("少数派");
    expect(cleanSiteName("The Verge")).toBe("The Verge");
  });
});

describe("gone and blocked detection", () => {
  it("recognizes the WeChat captcha page as blocked, not gone", () => {
    const html = fx("wechat-captcha.html");
    expect(detectBlocked("https://mp.weixin.qq.com/s?__biz=x", html)).toMatch(/微信/);
    expect(detectGone("https://mp.weixin.qq.com/s?__biz=x", html, 200)).toBeNull();
  });
  it("recognizes deleted WeChat articles", () => {
    expect(detectGone("https://mp.weixin.qq.com/s/abc", "<html><body><p>该内容已被发布者删除</p></body></html>", 200)).toBe("该内容已被发布者删除");
    expect(detectGone("https://e.com/x", "", 404)).toBe("HTTP 404");
  });
});

describe("mhtml", () => {
  it("parses a Chromium snapshot", () => {
    const m = parseMhtml(readFileSync(path.join(import.meta.dirname, "fixtures", "example.mhtml")));
    expect(m.url).toBe("https://example.com/");
    expect(m.html).toContain("Example Domain");
  });
});

describe("markdown", () => {
  it("converts articles", () => {
    expect(toMarkdown("<h2>标题</h2><p>正文 <strong>重点</strong></p>")).toBe("## 标题\n\n正文 **重点**\n");
  });
});
