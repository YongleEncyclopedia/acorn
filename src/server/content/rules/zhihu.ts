import type { SiteRule } from "./index.ts";

/** Zhihu columns and answers. Logged-out fetches are often blocked; browser capture works better. */
export const zhihu: SiteRule = {
  name: "zhihu",
  match: (u) => /(^|\.)zhihu\.com$/.test(u.hostname),
  extract: (doc) => {
    const body = doc.querySelector(".Post-RichText") || doc.querySelector(".RichContent-inner .RichText") || doc.querySelector(".RichText");
    if (!body) return null;
    for (const img of body.querySelectorAll("img")) {
      const real = img.getAttribute("data-original") || img.getAttribute("data-actualsrc");
      if (real) img.setAttribute("src", real);
    }
    for (const el of body.querySelectorAll("noscript")) el.remove();
    return {
      contentHtml: body.innerHTML,
      title: doc.querySelector(".Post-Title")?.textContent?.trim() || doc.querySelector(".QuestionHeader-title")?.textContent?.trim() || undefined,
      author: doc.querySelector(".AuthorInfo-name")?.textContent?.trim() || undefined,
      siteName: "知乎",
    };
  },
  gone: (html) => (/该内容暂时无法显示|你似乎来到了没有知识存在的荒原|内容已被删除/.test(html) ? "知乎提示内容已删除" : null),
  imageReferer: () => "https://www.zhihu.com/",
};
