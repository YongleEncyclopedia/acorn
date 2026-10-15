-- Machine translations, cached per source text so every device and every article reuses them.
create table translations (
  hash text not null,        -- sha1 of the whitespace-normalized source text
  lang text not null,        -- target language, e.g. zh-CN
  text text not null,
  model text,
  created_at integer not null,
  primary key (hash, lang)
) without rowid;
