-- 班级日历: classmates who chose to share their Canvas calendar link (a read-only feed of due dates and course
-- events; it carries no grades and can change nothing). Only what scheduling needs is kept of what it holds.
create table calendar_members (
  id integer primary key,
  name text not null,
  url text not null unique,
  created_at integer not null,
  checked_at integer,
  error text
);

create table calendar_member_events (
  member_id integer not null references calendar_members(id) on delete cascade,
  uid text not null,
  summary text not null,
  start_at integer not null,
  end_at integer not null,
  all_day integer not null default 0,
  primary key (member_id, uid)
);

-- events written to the Feishu calendar, so that later syncs update and remove them instead of adding copies
create table calendar_sync (
  key text primary key,
  remote_id text not null,
  hash text not null,
  synced_at integer not null
);
