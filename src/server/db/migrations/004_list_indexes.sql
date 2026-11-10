-- Indexes for the two lists that used to walk every entry in a large library.

-- 未读 / 今日: unread entries by time. Without it the list follows the time index and looks up each row to see
-- whether it is unread, so a library with 100k read entries and a handful of unread ones scanned nearly all of them.
create index entries_unread_time on entries (sort_at desc) where read_at is null;

-- 在读: the count is part of every bootstrap. A partial index is only used when the query repeats this condition
-- literally (see EntryStore.list and counts() in app.ts; tests/server.test.ts checks the query plans).
create index entries_in_progress on entries (progress_at) where progress > 0.02 and progress < 0.97;
