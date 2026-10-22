# AGENTS.md — working on Acorn 松果

Acorn is a single-user, self-hosted information system: subscriptions (RSS, RSSHub, scraped web pages, plugins),
a reader web app (PWA), highlights/notes, and a local archive that preserves pages, images and attachments on disk.
The owner wants to keep tinkering with it through agents. Make focused changes, keep the code readable, run the tests.

## Run

```bash
npm install && npm run build && npm start   # http://localhost:7700, data in ./data
npm test                                    # vitest: unit + end-to-end (fixture website on localhost)
npm run typecheck                           # tsc for server (tsconfig.json) — and `npx tsc -p web/tsconfig.json` for the web app
./bin/acorn help                            # CLI (talks to the running server; token in data/.cli-token)
```

Node ≥ 22.18 runs the server's TypeScript directly (type stripping). Rules that follow from that:
- relative imports end in `.ts`; type-only imports use `import type`
- no `enum`, no `namespace`, no constructor parameter properties (erasable syntax only)
- the database is `node:sqlite` (FTS5 with the trigram tokenizer for Chinese search); no native modules

## Map

```
src/server/
  main.ts              process entry: config, app context, HTTP server, scheduler
  config.ts            env → Config (ACORN_PORT, ACORN_DATA_DIR, RSSHUB_BASE, TELEGRAM_* …)
  app.ts               App context (db, stores, event bus, job queue), counts, CLI token
  db/                  Db wrapper + SQL migrations (add a new numbered file; never edit applied ones)
  store/               one class per table group: feeds, entries, archives, highlights, settings, tokens, imports
  feeds/               source.ts (fetch any source kind), parse.ts (feedsmith → items), refresh.ts,
                       add.ts (preview/discovery/subscribe), html-source.ts (CSS rules + list auto-detection),
                       plugins.ts + plugin-api.ts, rsshub.ts, opml.ts, icons.ts,
                       wechat-bridge.ts (mirror we-mp-rss accounts as feeds)
  content/             sanitize.ts (the only HTML allow-list), extract.ts (site rule → CMS containers → Readability),
                       rules/*.ts (per-site: wechat, zhihu, xiaohongshu, sspai), fulltext.ts, markdown.ts
  archive/             capture.ts (pipeline), assets.ts (images + attachments to disk), template.ts (offline page),
                       browser.ts (ego-browser capture: HTML + MHTML + screenshot), mhtml.ts, recheck.ts,
                       wayback.ts (Internet Archive: find the closest capture, unwrap it, archive it as a snapshot)
  import/              parse.ts (bookmarks HTML, Pocket/Instapaper/Raindrop/Readwise CSV, JSON, text → links),
                       run.ts (background worker over import_items: capture, rescue from the Wayback Machine, report)
  api/                 http.ts (Hono app, auth gate, static), routes/*.ts, greader.ts (Google Reader API),
                       outputs.ts (re-publish as RSS), auth.ts, content.ts (image proxy URL rewriting)
  translate/           engine.ts (Ollama / OpenAI-compatible / Anthropic, numbered-segment prompt), index.ts (job queue + cache),
                       summary.ts (key points, cached in the same table under `summary:<lang>`)
  util/net.ts          addresses other devices can reach (LAN, Tailscale, public URL) for login links
  scheduler.ts         refresh loop, archive recheck, starred→archive sweep, Telegram digest, daily backup (croner)
  backup.ts            a second data directory: SQLite online backup + new snapshot folders copied once; never deletes
  export.ts            the library as a ZIP, streamed: Markdown pack (articles + images, notes, OPML) or the full data dir
  util/zip.ts          dependency-free streaming ZIP writer (deflate, data descriptors, ZIP64)
  notify/telegram.ts
src/shared/types.ts    API types shared by server and web — change both sides together
src/shared/translate.ts which article blocks get translated, language detection (runs on linkedom and in the browser)
src/client/client.ts   HTTP client used by the CLI and MCP server
src/cli/main.ts        `acorn` CLI
src/mcp/server.ts      MCP server (stdio)
web/src/               React 19 + TanStack Query + wouter; views/*, components/*, lib/*, styles/*.css (design tokens in tokens.css)
plugins/               user plugins (TypeScript, hot-reloaded)
tests/                 vitest; fixtures are real pages saved from the web
```

## Common tasks

- **A site extracts badly** → add `src/server/content/rules/<site>.ts` (see `sspai.ts`), register it in `rules/index.ts`,
  save a fixture page under `tests/fixtures/` and add a test in `tests/content.test.ts`.
  For one feed only, setting `config.contentSelector` on the feed is enough (UI: 订阅源设置 → 高级).
- **A web page source picks the wrong list** → edit the feed's `config.html` rule (item/title/link/date selectors,
  `selector@attr` for attributes). Preview with `acorn preview <url> --kind html` or the MCP tool `preview_source`.
- **A source needs logic (JSON API, pagination, login)** → write a plugin in `plugins/` (see `docs/plugins.md`).
- **A site blocks the server** → captures can go through the user's browser: `acorn archive <url> --browser`.
  On a captcha / login wall the page is handed to the user (ego-browser `handOff`) and listed at `/api/archives/pending`;
  after they pass it, `acorn resume <space id>` (or the banner in the web app) takes the page back and archives it.
  WeChat issues verification per article (a `poc_token` on the URL), and a direct connection does not avoid it.
  Never try to solve captchas.
- **An export file from another tool does not parse** → `src/server/import/parse.ts` sniffs the format from the
  content (Netscape bookmarks, CSV header names, JSON keys); add the alias there and a case in `tests/import.test.ts`.
- **WeChat Official Accounts** → they come from we-mp-rss (`services/we-mp-rss/`, Docker on 127.0.0.1:8001; see its README).
  Settings `wechatBridge.url` makes Acorn subscribe to every account listed there (every 10 min, `acorn wechat sync`).
  The WeChat rule has `preferFeedCopy`: Acorn never fetches mp.weixin.qq.com pages for those entries; archives use
  the feed's full text, and an entry whose body arrives later is archived then. Its QR login needs the user.
- **Schema change** → new file `src/server/db/migrations/00N_name.sql`; update the store and `src/shared/types.ts`.
- **Translation** → the reader sends block texts to `POST /api/translate`; translations are cached per text hash in the
  `translations` table and inserted under each block by `web/src/lib/translate.ts` (marked `data-acorn-tr`, which
  highlights and block detection skip). Engines live in `src/server/translate/engine.ts`; tests use fake servers.
- **UI change** → `web/src`; keep colors as CSS variables in `styles/tokens.css` (5 themes must stay readable);
  check desktop (three panes) and mobile (≤ 760px, tab bar) layouts.

## Data safety

- `data/` is the user's library (database, archive files, cache). Never delete or rewrite it without asking.
- Archive snapshot folders are immutable once written; new captures create new timestamped folders.
- Article HTML is untrusted: everything rendered goes through `content/sanitize.ts` (server) and DOMPurify (web);
  archive files are served with a CSP that disables scripts. Keep it that way.

## API in one breath

Session cookie (web) or `Authorization: Bearer <token>` (CLI/MCP/scripts). JSON under `/api/*`:
`bootstrap, counts, feeds (+/preview, /:id/refresh, /:id/logs), folders, entries (list/detail/PATCH/fulltext/mark),
archives (list/detail/POST capture/import/:id/snapshot/:id/recheck/:id/wayback/PATCH/DELETE),
imports (list/POST file/preview/:id/items/:id/retry/PATCH/DELETE — moving in from other tools), export (ZIP, ?full=1),
backup (status/POST run), highlights, search, settings,
tokens, stats, logs, opml, digest, events (SSE), img (image proxy), translate (+/:id, /models, /test), summary, wechat-bridge (+/sync),
addresses, login-link`. One-time sign-in: `GET /login/<token>` (public; the token comes from `POST /api/login-link`). Archive files: `/files/archive/<path>`.
Google Reader API: `/accounts/ClientLogin`, `/reader/api/0/*` (also under `/api/greader`). RSS out: `/out/*.xml?key=`.
