-- Acorn schema v1. All timestamps are epoch milliseconds.

create table folders (
  id integer primary key,
  name text not null unique,
  sort integer not null default 0,
  created_at integer not null default (unixepoch() * 1000)
);

create table feeds (
  id integer primary key,
  kind text not null default 'feed' check (kind in ('feed', 'rsshub', 'html', 'plugin')),
  -- feed: feed URL; rsshub: route such as /bilibili/user/dynamic/2267573; html: page URL; plugin: plugin id
  url text not null,
  title text not null default '',
  custom_title text,
  site_url text,
  description text,
  has_icon integer not null default 0,
  folder_id integer references folders(id) on delete set null,
  -- JSON: html selector rule, plugin params, extra headers, cookie, user agent
  config text not null default '{}',
  full_text text not null default 'auto' check (full_text in ('never', 'auto', 'always')),
  auto_archive integer not null default 0,
  fetch_interval integer,
  paused integer not null default 0,
  etag text,
  last_modified text,
  last_fetched_at integer,
  last_success_at integer,
  next_fetch_at integer not null default 0,
  error_count integer not null default 0,
  last_error text,
  created_at integer not null default (unixepoch() * 1000),
  unique (kind, url)
);

create table entries (
  id integer primary key,
  feed_id integer not null references feeds(id) on delete cascade,
  guid text not null,
  url text,
  title text not null default '',
  author text,
  summary text,
  content text,
  full_content text,
  full_fetched_at integer,
  full_error text,
  image text,
  published_at integer,
  created_at integer not null default (unixepoch() * 1000),
  read_at integer,
  starred_at integer,
  progress real not null default 0,
  progress_at integer,
  word_count integer not null default 0,
  content_hash text,
  -- sort key: publish time, unless missing or implausibly in the future
  sort_at integer generated always as (
    case when published_at is null or published_at > created_at + 86400000 then created_at else published_at end
  ) virtual,
  unique (feed_id, guid)
);
create index entries_feed_time on entries (feed_id, sort_at desc);
create index entries_time on entries (sort_at desc);
create index entries_unread on entries (feed_id) where read_at is null;
create index entries_starred on entries (starred_at) where starred_at is not null;
create index entries_url on entries (url);

create virtual table entries_fts using fts5 (title, body, tokenize = 'trigram');

create table archives (
  id integer primary key,
  url text not null unique,
  entry_id integer references entries(id) on delete set null,
  title text not null default '',
  site text,
  author text,
  published_at integer,
  excerpt text,
  lead_image text,
  tags text not null default '[]',
  note text,
  dir text not null,
  latest_snapshot_id integer,
  source_status text not null default 'alive' check (source_status in ('alive', 'changed', 'gone', 'unknown')),
  source_checked_at integer,
  gone_at integer,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
);
create index archives_created on archives (created_at desc);
create index archives_entry on archives (entry_id);

create table snapshots (
  id integer primary key,
  archive_id integer not null references archives(id) on delete cascade,
  captured_at integer not null,
  method text not null,
  dir text not null,
  content_hash text not null,
  text_length integer not null default 0,
  bytes integer not null default 0,
  assets integer not null default 0,
  has_mhtml integer not null default 0,
  has_screenshot integer not null default 0,
  status text not null default 'ok',
  warnings text not null default '[]'
);
create index snapshots_archive on snapshots (archive_id, captured_at desc);

create virtual table archives_fts using fts5 (title, body, tokenize = 'trigram');

create table highlights (
  id integer primary key,
  entry_id integer references entries(id) on delete cascade,
  archive_id integer references archives(id) on delete cascade,
  quote text not null,
  prefix text not null default '',
  suffix text not null default '',
  note text,
  color text not null default 'amber',
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000),
  check (entry_id is not null or archive_id is not null)
);
create index highlights_entry on highlights (entry_id);
create index highlights_archive on highlights (archive_id);

create virtual table highlights_fts using fts5 (quote, note, tokenize = 'trigram');

create table settings (
  key text primary key,
  value text not null
);

create table tokens (
  id integer primary key,
  name text not null,
  hash text not null unique,
  created_at integer not null default (unixepoch() * 1000),
  last_used_at integer
);

create table fetch_log (
  id integer primary key,
  feed_id integer not null references feeds(id) on delete cascade,
  at integer not null,
  status text not null,
  added integer not null default 0,
  ms integer not null default 0,
  error text
);
create index fetch_log_feed on fetch_log (feed_id, at desc);

-- keep full-text indexes free of orphans (also fires on cascading deletes)
create trigger entries_fts_delete after delete on entries begin
  delete from entries_fts where rowid = old.id;
end;
create trigger archives_fts_delete after delete on archives begin
  delete from archives_fts where rowid = old.id;
end;
create trigger highlights_fts_delete after delete on highlights begin
  delete from highlights_fts where rowid = old.id;
end;
