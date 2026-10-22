-- Moving in ("搬家"): links from browser bookmarks, Pocket, Instapaper, Raindrop… archived one by one in the background.
-- The rows are the queue, so an import picks up where it left off after a restart.
create table imports (
  id integer primary key,
  source text not null,                 -- detected format: bookmarks, pocket, instapaper, raindrop, readwise, csv, json, text
  label text not null,                  -- what the user sees, e.g. "浏览器书签 · bookmarks.html"
  options text not null default '{}',   -- JSON: { tags: string[], wayback: boolean }
  paused integer not null default 0,
  created_at integer not null,
  finished_at integer
);

create table import_items (
  id integer primary key,
  import_id integer not null references imports(id) on delete cascade,
  url text not null,
  title text,
  tags text not null default '[]',
  note text,
  saved_at integer,                     -- when it was saved in the old tool
  -- done: archived · rescued: original gone, saved from the Internet Archive · gone: original gone, no copy found
  -- failed: could not archive (blocked, timeout…) · skipped: already in the archive
  status text not null default 'pending' check (status in ('pending', 'done', 'rescued', 'gone', 'failed', 'skipped')),
  archive_id integer references archives(id) on delete set null,
  error text,
  attempts integer not null default 0,
  updated_at integer,
  unique (import_id, url)
);
create index import_items_queue on import_items (status, import_id, id);
