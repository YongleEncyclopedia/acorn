/**
 * Feeds that sites have but do not announce on the page: GitHub releases and commits, subreddits, Medium and
 * Substack authors, Bluesky and Mastodon profiles, arXiv categories, V2EX nodes. Offered when their pattern fits
 * the address, and kept only once fetched and read as feeds (previewSource probes them).
 */
export interface Hint {
  url: string;
  title: string;
}

const GITHUB_RESERVED = new Set(["about", "explore", "features", "login", "marketplace", "orgs", "pricing", "settings", "sponsors", "topics", "trending", "notifications", "search", "collections", "events", "codespaces", "new", "organizations", "apps", "customer-stories", "enterprise", "security", "site", "team"]);

export function siteFeeds(address: string): Hint[] {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const out: Hint[] = [];

  if (host === "github.com" && parts[0] && !GITHUB_RESERVED.has(parts[0].toLowerCase())) {
    if (parts.length >= 2) {
      const repo = `https://github.com/${parts[0]}/${parts[1]}`;
      out.push({ url: `${repo}/releases.atom`, title: `${parts[1]} 的新版本` }, { url: `${repo}/commits.atom`, title: `${parts[1]} 的提交` }, { url: `${repo}/tags.atom`, title: `${parts[1]} 的标签` });
    } else out.push({ url: `https://github.com/${parts[0]}.atom`, title: `${parts[0]} 在 GitHub 上的动态` });
  }
  if (/(^|\.)reddit\.com$/.test(host) && parts[1]) {
    if (parts[0] === "r") out.push({ url: `https://www.reddit.com/r/${parts[1]}/.rss`, title: `r/${parts[1]}` });
    if (parts[0] === "u" || parts[0] === "user") out.push({ url: `https://www.reddit.com/user/${parts[1]}/.rss`, title: `u/${parts[1]}` });
  }
  if (host === "medium.com" && parts[0]?.startsWith("@")) out.push({ url: `https://medium.com/feed/${parts[0]}`, title: `${parts[0]} 在 Medium` });
  else if (host === "medium.com" && parts[0]) out.push({ url: `https://medium.com/feed/${parts[0]}`, title: `${parts[0]} 在 Medium` });
  if (host.endsWith(".medium.com")) out.push({ url: `https://${u.hostname}/feed`, title: u.hostname });
  if (host.endsWith(".substack.com")) out.push({ url: `https://${u.hostname}/feed`, title: u.hostname });
  if (host === "bsky.app" && parts[0] === "profile" && parts[1]) out.push({ url: `https://bsky.app/profile/${parts[1]}/rss`, title: `${parts[1]} 在 Bluesky` });
  // Mastodon and other fediverse servers: /@name
  if (parts.length === 1 && parts[0].startsWith("@") && host !== "medium.com" && host !== "youtube.com") out.push({ url: `${u.origin}/${parts[0]}.rss`, title: `${parts[0]}@${u.hostname}` });
  if (host === "arxiv.org" && parts[0] === "list" && parts[1]) out.push({ url: `https://rss.arxiv.org/rss/${parts[1]}`, title: `arXiv ${parts[1]}` });
  if (host === "v2ex.com" && parts[0] === "go" && parts[1]) out.push({ url: `https://www.v2ex.com/feed/${parts[1]}.xml`, title: `V2EX ${parts[1]}` });
  if (host === "news.ycombinator.com") out.push({ url: "https://news.ycombinator.com/rss", title: "Hacker News" });
  return out;
}
