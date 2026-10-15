import type { SiteRule } from "./index.ts";

/** 少数派 (sspai.com): the article body lives in .article__main__content; the header carries author/metadata noise. */
export const sspai: SiteRule = {
  name: "sspai",
  match: (u) => /(^|\.)sspai\.com$/.test(u.hostname),
  extract: (doc) => {
    const body = doc.querySelector(".article__main__content") || doc.querySelector(".article-body .wangEditor-txt");
    if (!body) return null;
    const banner = doc.querySelector(".article__header__banner__image")?.getAttribute("src") || null;
    return {
      contentHtml: body.innerHTML,
      title: doc.querySelector(".article__main__title, h1.title")?.textContent?.trim() || undefined,
      siteName: "少数派",
      leadImage: banner,
    };
  },
};
