import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sanitize } from "../src/server/content/sanitize.ts";
import { extractArticle, cleanSiteName, trimArticleHead } from "../src/server/content/extract.ts";
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

describe("short pages", () => {
  // Readability starts every <div> at 5 points (an <article> at 0) and skips paragraphs under 25 characters, so one
  // address line in a footer <div> used to out-score a short article, and the footer became the archived text.
  const nav = `<ul class="nav"><li><a href="/">首页</a></li><li><a href="/tzgg">通知公告</a></li></ul>`;
  const foot = `<div class="foot"><p>版权所有 © 2026 示例学院　地址：示例市示例路 1 号</p><p>京ICP备00000000号</p></div>`;
  const text = (body: string, footer = foot) => extractArticle(`<html><body>${nav}${body}${footer}</body></html>`, "http://127.0.0.1:8080/tzgg/1.html")?.text ?? null;
  const story = "上周想重读一篇讲松鼠贮藏习性的长文，点开收藏的链接，页面只剩下一句话。好在当时顺手存了一份，原文和配图都还在。";
  const notice = "<h1>关于停水的通知</h1><p>明日上午九点至十一点停水。</p><p>请各位师生提前储水。</p><p>特此通知。</p>";
  const noticeText = "关于停水的通知\n明日上午九点至十一点停水。\n请各位师生提前储水。\n特此通知。";
  const two = "<p>上周想重读一篇讲松鼠贮藏习性的长文，点开收藏的链接，页面只剩下一句话。</p><p>好在当时顺手存了一份，原文和配图都还在，于是又从头读了一遍。</p>";
  const twoText = "上周想重读一篇讲松鼠贮藏习性的长文，点开收藏的链接，页面只剩下一句话。\n好在当时顺手存了一份，原文和配图都还在，于是又从头读了一遍。";

  it("keeps the text of the page's <article> or <main>, not its footer", () => {
    expect(text(`<article><h1>记一次链接失效</h1><p>${story}</p></article>`)).toBe(`记一次链接失效\n${story}`);
    expect(text(`<article><h1>记一次链接失效</h1>${two}</article>`)).toBe(`记一次链接失效\n${twoText}`);
    expect(text(`<article>${notice}</article>`)).toBe(noticeText);
    expect(text(`<main>${notice}</main>`)).toBe(noticeText);
    expect(text(`<div role="main">${notice}</div>`)).toBe(noticeText);
  });

  it("is not thrown by a footer longer than the article", () => {
    // the longest of Readability's attempts is the footer; this one also carries a line of unit names
    const long = `<div class="footer"><p>示例学院学生工作部（处）　示例学院团委　示例学院后勤服务中心　示例学院图书馆</p><p>版权所有 © 2026 示例学院　地址：示例市示例区示例路 1 号　邮编：100000　电话：010-00000000　传真：010-00000001</p><p>京ICP备00000000号-1　京公网安备 11010802000000号　技术支持：示例网络科技有限公司</p></div>`;
    expect(text(`<article><h1>记一次链接失效</h1>${two}</article>`, long)).toBe(`记一次链接失效\n${twoText}`);
    expect(text(`<article>${notice}</article>`, long)).toBe(noticeText);
  });

  it("leaves Readability's pick alone when it lies within the article, or the article is not the page's text", () => {
    // within: Readability drops the date line
    expect(text(`<article><h1>记一次链接失效</h1><div class="meta">发布时间：2026-10-01</div><div class="body">${two}</div></article>`)).toBe(twoText);
    // a short text next to a teaser in the sidebar
    expect(text(`<div class="post-body">${two}</div><aside><article><h3>相关阅读</h3><p>松鼠怎么记住埋橡果的地方？研究者在校园里跟踪了三十只松鼠。</p></article></aside>`)).toBe(twoText);
    // a long body next to the page's only <article>, a header card
    const long = "<p>松鼠在秋天把橡果埋进土里，留到冬天慢慢吃，有些橡果被忘在土里，第二年春天长成了小橡树。</p>".repeat(6);
    const card = text(`<article class="post-header"><h1>松鼠的贮藏</h1><p>2026-10-01</p></article><div class="post-body">${long}</div>`);
    expect(card?.startsWith("松鼠在秋天把橡果埋进土里")).toBe(true);
    expect(card?.length).toBeGreaterThan(200);
  });

  it("never keeps a footer as the article when the page marks no content", () => {
    expect(text(`<div class="main-content">${notice}</div>`)).toBeNull();
    // the CMS containers still get their turn after Readability
    expect(text(`<div class="article-content">${notice}</div>`)).toBe(noticeText);
    // contact details alone are not a footer
    const contact = "<h1>联系我们</h1><p>地址：示例市示例区示例路 1 号示例学院行政楼 201 室</p><p>电话：010-00000000</p><p>邮箱：office@example.edu</p>";
    expect(text(`<div class="content">${contact}</div>`)).toContain("行政楼 201 室");
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

describe("publish dates printed in the page", () => {
  it("reads 发布日期 / 发布时间 when there is no metadata, ignoring commented-out dates", () => {
    const body = "<p>根据学校安排，现将寒假期间档案查阅利用的安排通知如下，请各位老师和同学留意开放时间与预约方式。</p>".repeat(6);
    const page = (meta: string) => `<html><head><title>查档公告</title></head><body><!-- <em>2020-01-01</em> --><div class="info">${meta}</div><article><h1>查档公告</h1>${body}</article></body></html>`;
    const at = (html: string) => {
      const t = extractArticle(html, "https://archives.example.edu/info/1/2.htm")?.publishedAt;
      return t ? new Date(t).toLocaleDateString("en-CA") : null;
    };
    expect(at(page("发布日期：2026-07-29 撰稿：　摄影："))).toBe("2026-07-29");
    expect(at(page("发布时间: 2026年7月29日 10:30"))).toBe("2026-07-29");
    expect(at(page("活动时间：2026-08-03"))).toBeNull();
  });
});

describe("article head clean-up", () => {
  const title = "关于第五届研究生学术英语词汇竞赛报名的通知";
  const body = "<p>各位同学：为提升研究生学术英语水平，现组织第五届学术英语词汇竞赛，有关事项通知如下。</p><p>一、报名时间：即日起至11月1日。</p>";
  it("removes the repeated title and the date / views / share lines above the text", () => {
    const html = `<div><div><h3>${title}</h3><div><p><span><i></i>发布时间：2026-10-13</span><span><i></i>点击数：17893</span></p><p><span>分享至：</span><span><i></i></span></p></div></div><div>${body}</div></div>`;
    const out = trimArticleHead(html, [`${title} - 研究生院`]);
    expect(out).not.toContain(title);
    expect(out).not.toMatch(/点击数|分享至|2026-10-13/);
    expect(out).toContain("各位同学");
    expect(out).toContain("报名时间：即日起");
  });
  it("also handles bare date and counter lines, and leaves articles without a header alone", () => {
    const bare = `<h3>${title}</h3><p><span>2026.10.13</span> <span>17893</span></p>${body}`;
    expect(trimArticleHead(bare, [title])).toBe(body);
    expect(trimArticleHead(body, [title])).toBe(body);
    const startsWithImage = `<p><img src="a.png"></p><h3>${title}</h3>${body}`;
    expect(trimArticleHead(startsWithImage, [title])).toBe(startsWithImage);
  });
});
