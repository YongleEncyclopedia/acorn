import type { SiteRule } from "./index.ts";

interface XhsImage {
  urlDefault?: string;
  url?: string;
  infoList?: { url?: string }[];
}

function pickNote(state: unknown): Record<string, unknown> | null {
  const s = state as { note?: { noteDetailMap?: Record<string, { note?: Record<string, unknown> }> } };
  const map = s?.note?.noteDetailMap;
  if (!map) return null;
  for (const v of Object.values(map)) if (v?.note && (v.note as { noteId?: string }).noteId) return v.note;
  return null;
}

/**
 * Xiaohongshu notes. The page embeds window.__INITIAL_STATE__ with the note; this works on HTML captured
 * through the logged-in browser (ego-browser). Plain server fetches are usually blocked.
 */
export const xiaohongshu: SiteRule = {
  name: "xiaohongshu",
  match: (u) => /(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(u.hostname),
  extract: (doc, _url, html) => {
    const raw = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/)?.[1];
    if (raw) {
      try {
        const state = JSON.parse(raw.replace(/:\s*undefined/g, ":null").replace(/;\s*$/, ""));
        const note = pickNote(state);
        if (note) {
          const images = ((note.imageList as XhsImage[]) || [])
            .map((im) => im.urlDefault || im.url || im.infoList?.[im.infoList.length - 1]?.url)
            .filter((x): x is string => !!x);
          const desc = String(note.desc || "")
            .split(/\n/)
            .map((l) => `<p>${l.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</p>`)
            .join("");
          const user = (note.user as { nickname?: string })?.nickname;
          return {
            title: String(note.title || "") || undefined,
            author: user,
            siteName: "小红书",
            publishedAt: typeof note.time === "number" ? note.time : null,
            contentHtml: `${desc}${images.map((src) => `<figure><img src="${src}"></figure>`).join("")}`,
            leadImage: images[0] || null,
          };
        }
      } catch {
        /* fall through to DOM */
      }
    }
    const desc = doc.querySelector("#detail-desc") || doc.querySelector(".note-text");
    const imgs = [...doc.querySelectorAll(".swiper-slide img, .note-slider img, .media-container img")]
      .map((i) => i.getAttribute("src"))
      .filter((x): x is string => !!x);
    const metaImgs = [...doc.querySelectorAll('meta[name="og:image"], meta[property="og:image"]')]
      .map((m) => m.getAttribute("content"))
      .filter((x): x is string => !!x);
    const images = [...new Set(imgs.length ? imgs : metaImgs)];
    if (!desc && !images.length) return null;
    return {
      title: doc.querySelector("#detail-title")?.textContent?.trim() || undefined,
      author: doc.querySelector(".author-wrapper .username")?.textContent?.trim() || undefined,
      siteName: "小红书",
      contentHtml: `${desc ? desc.innerHTML : ""}${images.map((src) => `<figure><img src="${src}"></figure>`).join("")}`,
      leadImage: images[0] || null,
    };
  },
  gone: (html) => (/当前笔记暂时无法浏览|笔记不存在|该笔记已被删除/.test(html) ? "小红书提示笔记不可见" : null),
  imageReferer: () => "https://www.xiaohongshu.com/",
};
