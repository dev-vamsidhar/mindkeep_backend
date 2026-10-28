-- Notes: markdown documents in their own folder tree (folders.kind = 'notes'), synced like cards.
-- Same cost pattern as cards: PK is the table, one index for delta pulls.
ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'cards'; -- 'cards' or 'notes'

CREATE TABLE notes (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL, -- markdown
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
CREATE INDEX notes_sync ON notes(user_id, synced_at);
