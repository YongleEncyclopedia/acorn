---
name: acorn
description: Operate Acorn 松果, the user's self-hosted reader and local archive. Use when the user asks to subscribe to a source, find or summarize what they read, archive a web page (including WeChat/Xiaohongshu/Zhihu via their browser), work with highlights/notes, or fix a source that stopped updating.
---

# Acorn 松果

Acorn runs on the user's computer (default http://127.0.0.1:7700). Prefer the MCP tools when they are available
(`acorn_overview`, `list_entries`, `read_entry`, `search`, `add_feed`, `preview_source`, `archive`, `list_archives`,
`read_archive`, `list_highlights`, `add_highlight`, `update_feed`, `refresh_feed`, `digest`). Otherwise use the CLI
from the project folder — every command accepts `--json`:

```bash
./bin/acorn status --json
./bin/acorn unread --limit 20 --json
./bin/acorn read <entryId> --json          # Markdown body + highlights; marks read (add --no-mark to keep unread)
./bin/acorn search "关键词" --json
./bin/acorn add <url | rsshub://route | plugin:id> [--folder 名称] [--auto-archive]
./bin/acorn preview <url> [--kind html] --json
./bin/acorn archive <url | entryId> [--browser] [--tag 标签]
./bin/acorn archives [--gone] --json
./bin/acorn notes --json
```

## Playbooks

- **Subscribe to something**: run `preview` first. A page with no feed returns `kind: "html"` and a suggested CSS rule;
  check that the preview items look right before subscribing. For RSSHub routes see https://docs.rsshub.app.
- **A source broke** (`status` lists failing feeds): read the error, `preview` the URL again, then fix the URL, the
  HTML rule (`update_feed` with `html_rule`), or write a plugin in `plugins/` (see `docs/plugins.md`).
- **Archive a walled page**: use `archive` with `method: "browser"` (CLI `--browser`). If Acorn answers that a
  verification is needed, it has already opened the page in the user's ego-browser and returns a space id. Ask the
  user to pass the verification there, then call `resume_browser_capture` (CLI `acorn resume <space id>`).
  WeChat issues the verification per article, so each WeChat article needs the user once. Never attempt to solve captchas.
- **The user already opened a page** in an ego-browser space: `archive_open_tab` (CLI `acorn from-browser <space id>`).
- **Follow a WeChat Official Account**: add it in we-mp-rss (http://127.0.0.1:8001, search by name or paste one of
  its article links); Acorn subscribes within 10 minutes, or right away with `wechat_accounts` `sync: true`
  (CLI `acorn wechat sync`). If we-mp-rss says its WeChat login expired, ask the user to scan its QR code again.
- **Summaries / research**: `search` and `read_entry` / `read_archive` give Markdown; cite the original URL.
- **Do not** delete archives or the `data/` folder unless the user explicitly asks.
