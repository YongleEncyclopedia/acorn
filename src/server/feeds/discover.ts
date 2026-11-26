import { parseHTML } from "linkedom";
import { absolutize } from "../util/url.ts";
import type { FeedKind } from "../../shared/types.ts";

export interface Candidate {
  url: string;
  title: string;
  kind: FeedKind;
}

const FEED_TYPES = /application\/(rss|atom|rdf|feed)\+xml|application\/(feed\+)?json|text\/xml|application\/xml/i;

/** The feeds a page declares (<link rel="alternate">). Links that only look like feeds are in feedLinks(). */
export function discoverFeeds(html: string, pageUrl: string): Candidate[] {
  const { document } = parseHTML(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const link of document.querySelectorAll('link[rel~="alternate"], link[rel="feed"]')) {
    const type = link.getAttribute("type") || "";
    if ((type && !FEED_TYPES.test(type)) || /oembed/i.test(type)) continue;
    // <link rel="alternate" hreflang="en"> is the page in another language, not a feed
    if (!type && link.hasAttribute("hreflang")) continue;
    const href = absolutize(link.getAttribute("href"), pageUrl);
    if (!href || seen.has(href)) continue;
    if (/comments?\/feed|\/comments\//i.test(href)) continue;
    seen.add(href);
    out.push({ url: href, title: link.getAttribute("title") || "", kind: "feed" });
  }
  return out;
}

/**
 * Links that may be feeds or a page listing them: "/rss.html" (日经中文网's feed has that address), "/feed/",
 * "/rss/index.xml", or a link that reads "RSS" / "订阅源". To be checked by reading them.
 */
export function feedLinks(html: string, pageUrl: string): { url: string; title: string }[] {
  const { document } = parseHTML(html);
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = absolutize(a.getAttribute("href"), pageUrl);
    if (!href || seen.has(href) || !/^https?:/i.test(href)) continue;
    const text = (a.textContent || "").replace(/\s+/g, " ").trim();
    let path = "";
    try {
      const u = new URL(href);
      path = u.pathname + u.search;
    } catch {
      continue;
    }
    if (/(^|[/._?=&-])(rss|feeds?|atom|rdf)([/._?=&-]|$)/i.test(path) || /^(rss|atom|feeds?|rss ?订阅|订阅源|rss ?feed)$/i.test(text)) {
      seen.add(href);
      out.push({ url: href, title: text.length < 60 ? text : "" });
    }
    if (out.length >= 10) break;
  }
  return out;
}

/** Common feed locations to probe when a page advertises nothing. */
export function guessFeedUrls(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  return ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml", "/feed.json"].map((p) => new URL(p, u.origin).toString());
}
