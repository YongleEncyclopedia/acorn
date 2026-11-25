-- What a source keeps between two fetches (a watched page's last text). Per subscription, and gone with it.
create table plugin_state (
  feed_id integer not null references feeds(id) on delete cascade,
  key text not null,
  value text not null,
  primary key (feed_id, key)
);
