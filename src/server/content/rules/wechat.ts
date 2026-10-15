import type { SiteRule } from "./index.ts";

const GONE = [
  "该内容已被发布者删除",
  "此内容因违规无法查看",
  "此内容被多人投诉，相关的内容无法进行查看",
  "该公众号已迁移",
  "此内容发送失败无法查看",
  "该账号已被封禁",
  "此帐号已被封禁",
  "该内容暂时无法查看",
  "此内容因涉嫌违反相关法律法规和政策无法查看",
];

/** WeChat Official Account articles (mp.weixin.qq.com). Images are lazy (data-src) and hotlink-protected. */
export const wechat: SiteRule = {
  name: "wechat",
  match: (u) => u.hostname === "mp.weixin.qq.com",
  extract: (doc, _url, html) => {
    const body = doc.querySelector("#js_content") || doc.querySelector(".rich_media_content");
    if (!body) return null;
    body.removeAttribute("style");
    for (const img of body.querySelectorAll("img")) {
      const ds = img.getAttribute("data-src");
      if (ds) img.setAttribute("src", ds);
    }
    for (const el of body.querySelectorAll("mp-style-type, .js_uneditable, .reward_area, .qr_code_pc")) el.remove();
    const title = doc.querySelector("#activity-name")?.textContent?.trim() || doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
    const account = doc.querySelector("#js_name")?.textContent?.trim() || doc.querySelector(".profile_nickname")?.textContent?.trim() || "";
    const author = doc.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() || "";
    const ct = html.match(/var\s+ct\s*=\s*["']?(\d{9,10})["']?/)?.[1] || html.match(/create_time\s*[:=]\s*["']?(\d{9,10})/)?.[1];
    const lead = doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
    return {
      contentHtml: body.innerHTML,
      title,
      author: author && author !== account ? `${account} · ${author}` : account,
      siteName: account || "微信公众号",
      publishedAt: ct ? Number(ct) * 1000 : null,
      leadImage: lead,
    };
  },
  gone: (html) => {
    if (html.includes('id="js_content"')) return null;
    return GONE.find((p) => html.includes(p)) || null;
  },
  blocked: (html, finalUrl) =>
    /wappoc_appmsgcaptcha/.test(finalUrl) || (!html.includes('id="js_content"') && /poc_token|环境异常/.test(html)) ? "微信要求人机验证（环境异常）" : null,
  imageReferer: () => null,
  // Cookie-less requests often get the "环境异常" captcha; feeds from we-mp-rss usually carry the full text.
  preferFeedCopy: true,
  // we-mp-rss builds links from WeChat Reading review ids, which write "_" in the short id as "~" ("参数错误" otherwise).
  fixUrl: (u) => (u.pathname.startsWith("/s/") && u.pathname.includes("~") ? `${u.origin}${u.pathname.replaceAll("~", "_")}${u.search}` : null),
};
