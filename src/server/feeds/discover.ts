import { parseHTML } from "linkedom";
import { absolutize } from "../util/url.ts";
import type { FeedKind } from "../../shared/types.ts";

export interface Candidate {
  url: string;
  title: string;
  kind: FeedKind;
}

const FEED_TYPES = /application\/(rss|atom|rdf|feed)\+xml|application\/(feed\+)?json|text\/xml|application\/xml/i;

/** Find <link rel="alternate"> feeds and well-known feed paths on a web page. */
export function discoverFeeds(html: string, pageUrl: string): Candidate[] {
  const { document } = parseHTML(html);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const link of document.querySelectorAll('link[rel~="alternate"], link[rel="feed"]')) {
    const type = link.getAttribute("type") || "";
    if (type && !FEED_TYPES.test(type)) continue;
    const href = absolutize(link.getAttribute("href"), pageUrl);
    if (!href || seen.has(href)) continue;
    if (/comments?\/feed|\/comments\//i.test(href)) continue;
    seen.add(href);
    out.push({ url: href, title: link.getAttribute("title") || "", kind: "feed" });
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = absolutize(a.getAttribute("href"), pageUrl);
    if (!href || seen.has(href)) continue;
    if (/\/(feed|rss|atom)(\.xml|\.json)?\/?$|\/(index|rss|feed|atom)\.(xml|rss)$/i.test(new URL(href).pathname)) {
      seen.add(href);
      out.push({ url: href, title: a.textContent?.trim() || "", kind: "feed" });
    }
    if (out.length > 12) break;
  }
  return out;
}

/** Common feed locations to probe when a page advertises nothing. */
export function guessFeedUrls(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  return ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml", "/feed.json"].map((p) => new URL(p, u.origin).toString());
}
