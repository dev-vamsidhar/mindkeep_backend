-- One level of sub-folders: parent_id points at a top-level folder, or is NULL.
-- No index or foreign key: clients load all of a user's folders anyway, so this costs no extra writes.
-- Depth is kept at one level by the clients' flatten rule (a parent only counts if it is top-level).
ALTER TABLE folders ADD COLUMN parent_id TEXT;
