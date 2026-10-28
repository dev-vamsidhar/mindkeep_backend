-- Sync store for the local-first frontend. The browser is the source of truth; D1 holds a copy
-- so other devices can catch up. Users live in Firebase Auth, so there is no users table.
--
-- Cost notes (D1 bills rows read and rows written, and every index entry is a written row):
--  * WITHOUT ROWID + PRIMARY KEY (user_id, id): the primary key is the table itself, so no extra
--    index for it, and a client can never upsert over another user's row.
--  * Exactly one secondary index per table, on (user_id, synced_at), so a delta pull reads only changed rows.
--  * No foreign keys or cascades: deleting a folder writes one tombstone, and its cards are hidden by the client.
--  * Reviews are not stored one row each. Each device keeps a per-day count (activity), which is enough
--    for streaks and "reviewed today".
-- Timestamps are unix epoch milliseconds. updated_at comes from the client and decides last-write-wins;
-- synced_at is stamped by D1's clock and is the delta-pull cursor.

CREATE TABLE folders (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  dot TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
CREATE INDEX folders_sync ON folders(user_id, synced_at);

CREATE TABLE cards (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT NOT NULL, -- JSON array
  starred INTEGER NOT NULL,
  state INTEGER NOT NULL, -- 0 new, 1 learning, 2 review, 3 relearning (FSRS runs on the client)
  due INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  last_review INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
CREATE INDEX cards_sync ON cards(user_id, synced_at);

CREATE TABLE activity (
  user_id TEXT NOT NULL,
  device TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD in the device's local time
  count INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device, day)
) WITHOUT ROWID;
CREATE INDEX activity_sync ON activity(user_id, synced_at);
