import sanitizeHtml from "sanitize-html";
import { absolutize } from "../util/url.ts";

/** Hosts whose <iframe> embeds survive sanitization (video / audio players). */
const EMBED_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "player.bilibili.com",
  "player.vimeo.com",
  "open.spotify.com",
  "embed.music.apple.com",
  "w.soundcloud.com",
  "music.163.com",
];

const LAZY_ATTRS = ["data-src", "data-original", "data-actualsrc", "data-lazy-src", "data-lazyload", "data-echo", "data-url", "data-original-src", "data-croporisrc"];

/** Feeds sometimes double-encode URLs ("&amp;amp;"); a literal "&amp;" inside a URL is never intended. */
function fixAmp(u: string | undefined): string | undefined {
  return u ? u.replace(/&amp;/gi, "&") : u;
}

function isPlaceholder(src: string | undefined): boolean {
  if (!src) return true;
  return /^data:image\/(gif|svg|png);base64,.{0,200}$/i.test(src) || /(blank|placeholder|spacer|loading|lazy)[^/]*\.(gif|png|svg)/i.test(src) || src === "about:blank";
}

function absSrcset(srcset: string | undefined, base: string): string | undefined {
  if (!srcset) return undefined;
  const parts = srcset
    .split(/,\s+(?=\S)/)
    .map((p) => {
      const [u, d] = p.trim().split(/\s+/, 2);
      const a = absolutize(u, base);
      return a ? (d ? `${a} ${d}` : a) : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Sanitize untrusted HTML into the safe subset Acorn renders. Relative URLs become absolute. */
export function sanitize(html: string | null | undefined, baseUrl = "about:blank"): string {
  if (!html) return "";
  const base = baseUrl;
  return sanitizeHtml(html, {
    allowedTags: [
      "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
      "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "iframe", "img",
      "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "source",
      "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
      "video", "audio", "wbr", "article", "aside", "header", "footer", "main",
    ],
    allowedAttributes: {
      a: ["href", "title", "name"],
      img: ["src", "srcset", "alt", "title", "width", "height", "sizes"],
      source: ["src", "srcset", "type", "media", "sizes"],
      video: ["src", "poster", "controls", "width", "height", "loop", "muted", "playsinline"],
      audio: ["src", "controls", "loop"],
      iframe: ["src", "width", "height", "allowfullscreen", "frameborder", "title"],
      td: ["colspan", "rowspan", "align"],
      th: ["colspan", "rowspan", "align", "scope"],
      ol: ["start", "type", "reversed"],
      li: ["value"],
      time: ["datetime"],
      abbr: ["title"],
      q: ["cite"],
      blockquote: ["cite"],
      code: ["class"],
      pre: ["class"],
      span: ["class"],
      details: ["open"],
    },
    allowedClasses: {
      code: ["language-*", "lang-*", "hljs"],
      pre: ["language-*", "lang-*"],
      span: ["katex*", "math*"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"], source: ["http", "https"] },
    allowedIframeHostnames: EMBED_HOSTS,
    allowProtocolRelative: false,
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "template", "svg", "math", "button", "select", "form"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = absolutize(fixAmp(attribs.href), base);
        const out: Record<string, string> = {};
        if (href) out.href = href;
        if (attribs.title) out.title = attribs.title;
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        let src = fixAmp(attribs.src);
        if (isPlaceholder(src)) {
          for (const k of LAZY_ATTRS) {
            if (attribs[k] && !isPlaceholder(attribs[k])) {
              src = fixAmp(attribs[k]);
              break;
            }
          }
        }
        const out: Record<string, string> = {};
        const abs = src?.startsWith("data:") ? src : absolutize(src, base);
        if (abs) out.src = abs;
        const srcset = absSrcset(fixAmp(attribs.srcset || attribs["data-srcset"]), base);
        if (srcset) out.srcset = srcset;
        for (const k of ["alt", "title", "width", "height"]) if (attribs[k]) out[k] = attribs[k];
        return { tagName, attribs: out };
      },
      source: (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (attribs.src) out.src = absolutize(attribs.src, base) || "";
        const srcset = absSrcset(attribs.srcset || attribs["data-srcset"], base);
        if (srcset) out.srcset = srcset;
        return { tagName, attribs: out };
      },
      video: (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs, controls: "" };
        if (attribs.src) out.src = absolutize(attribs.src, base) || "";
        if (attribs.poster) out.poster = absolutize(attribs.poster, base) || "";
        return { tagName, attribs: out };
      },
      iframe: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: absolutize(attribs.src || attribs["data-src"], base) || "" } }),
      h1: "h2",
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        if (!frame.attribs.src) return true;
        if (frame.attribs.width === "1" || frame.attribs.height === "1") return true;
        if (/\b(feedburner|feedsportal|pixel|tracker|beacon)\b/i.test(frame.attribs.src)) return true;
        if (/(img-)?placeholder\.(png|gif|svg|jpe?g)|\/blank\.(gif|png)|spacer\.gif|\/avatars?\/|\/emoji\//i.test(frame.attribs.src)) return true;
      }
      if (frame.tag === "a" && !frame.text.trim() && !frame.mediaChildren?.length) return true;
      return false;
    },
  });
}
