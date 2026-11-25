-- Sign-ins to platforms that only show their content to an account (知识星球, Canvas…). The credential (a token
-- or the cookies of a browser sign-in) stays on this server: the API only ever says who is signed in and whether
-- it still works. Subscriptions refer to an account from their config (`plugin.account`).
create table accounts (
  id integer primary key,
  service text not null,
  -- the platform's address (Canvas runs at every school's own address)
  origin text not null,
  -- who the platform says is signed in
  name text not null default '',
  -- JSON: { "token": "…" } or { "cookie": "name=value; …" }
  secret text not null,
  status text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  error text,
  checked_at integer,
  created_at integer not null
);
create unique index accounts_service_origin on accounts (service, origin);
