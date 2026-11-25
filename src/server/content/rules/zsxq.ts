import type { SiteRule } from "./index.ts";

/** 知识星球: the topics come whole from the signed-in API (feeds/builtin/zsxq.ts); pictures load as the web client loads them. */
export const zsxq: SiteRule = {
  name: "知识星球",
  match: (u) => /(^|\.)zsxq\.com$/i.test(u.hostname),
  imageReferer: () => "https://wx.zsxq.com/",
};
