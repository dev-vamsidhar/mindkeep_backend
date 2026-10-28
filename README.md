# MindKeep API

Cloudflare Worker + D1, the sync backend for the local-first frontend in `../mindkeep_frontend`.
Sign-in is Firebase Auth (email/password and Google); the Worker verifies the Firebase ID token on every request (`src/auth.ts`).

```sh
npm install
npm run migrate:local && npm run dev   # http://localhost:8787
npm test && npm run typecheck          # token verifier unit tests
npm run smoke                          # end-to-end sync check against the dev server
```

Frontend: `cd ../mindkeep_frontend && npm run dev` (http://localhost:3000, the origin in `ALLOWED_ORIGIN`). Its `.env.local` holds the Firebase web config and `NEXT_PUBLIC_API_URL`. `npm test` there runs the FSRS scheduler tests.

Locally, `.dev.vars` sets `FIREBASE_AUTH_EMULATOR=true` so the smoke test can send unsigned emulator-style tokens. Never set it in production.

Deploy: `npx wrangler d1 create mindkeep`, paste the id into `wrangler.toml`, set `ALLOWED_ORIGIN` to the frontend's URL, then `npm run migrate:remote && npm run deploy`. Point the frontend's `NEXT_PUBLIC_API_URL` at the deployed Worker.

## How sync works

The browser is the source of truth. Every read and every write goes to memory and IndexedDB on the device (`mindkeep_frontend/lib/store.ts`), so the app works offline and never waits on the network. FSRS scheduling also runs on the device (`lib/fsrs.ts`). The server only stores a copy so other devices can catch up.

- **One endpoint.** `POST /api/sync { since, folders, cards, activity }` pushes the rows changed on this device and returns every row changed on the server since `since`, plus a new `cursor`. The pull and the pushes run in one D1 batch, which is one transaction.
- **Lazy and batched.** A change marks its row dirty and schedules a sync. The sync runs 30 seconds after the *first* unsynced change, so a whole review session's edits go up in one request. Syncs also run when the browser comes back online, when the tab is hidden, and as a pull every 10 minutes while the tab is visible. Failures retry after a minute. Each request carries at most 500 rows; bigger backlogs go in chunks.
- **Deltas only.** Each server row has a `synced_at` stamped by D1's own clock. Pulls ask for `synced_at >= cursor`, so an idle device reads nothing.
- **Conflicts: last write wins.** Each row carries the client's `updated_at`. The server only overwrites a row with a newer one, and the client only takes a pulled row if it is at least as new as its local copy. A row you push echoes back once on your next pull and is ignored.
- **Deletes are tombstones** (`deleted = 1`, with the card text cleared). Deleting a folder writes one row; its cards are hidden on the client, not deleted one by one.
- **Notes** are markdown documents with their own folder tree (`folders.kind = 'notes'`; card folders are `'cards'`), with the same one level of sub-folders. They sync in the same request as cards (a `notes` array), with the same delta pull, last-write-wins and 500-row chunks. Typing saves to the device after a 0.4 s pause; the server sees at most one upsert per note per sync, however much you typed. Conflicts are per note: if two devices edit the same note offline, the later save wins the whole note. Rendering (`mindkeep_frontend/lib/markdown.ts`) is GFM plus Obsidian syntax: `[[Note]]` and `[[Note|alias]]` links (clicking a missing one creates it), backlinks, `#tags`, `==highlights==` and clickable `- [ ]` checkboxes. The output is sanitized with DOMPurify. The editor is CodeMirror 6 with an Obsidian-style Live Preview (`mindkeep_frontend/components/LiveEditor.tsx`): markdown is styled as you type, markers are hidden except on the cursor line, and checkboxes, links and tables work in place. A Reading view is one toggle away (Ctrl/⌘+E).
- **Sub-folders, one level deep.** A folder's `parent_id` points at a top-level folder, or is null. The app only lets you create or move a sub-folder inside a top-level folder, and a folder that has sub-folders can't become one. If offline edits on two devices still produce a deeper chain, every device applies the same rule: a parent only counts if it is top-level itself, otherwise the folder shows at the top level. So the tree is always one level deep, with no extra reads or writes. The server rejects a folder that is its own parent. A parent folder's card counts, review scope and search include its sub-folders.
- **Deleting a folder that has sub-folders** deletes the sub-folders and all their cards with it (the app asks first and lists what goes). It writes a single tombstone for the parent; the sub-folders and cards are hidden because their parent is gone.
- **Accounts.** Cards made before signing in are adopted by the first account that signs in on that device. Logging out flushes pending changes, warns if any couldn't sync, and then clears the device.

## D1 cost choices

D1 bills rows read and rows written, and every index entry is a written row.

- Every table is `WITHOUT ROWID` with `PRIMARY KEY (user_id, id)`. The key is the table itself, so it needs no extra index, and one user can never overwrite another user's row.
- Each table has exactly one secondary index, on `(user_id, synced_at)`, so delta pulls read only changed rows.
- There is no per-review log. Each device keeps one counter row per day (`activity`), which is enough for streaks and "reviewed today". A review costs one card upsert plus, at most, one counter upsert per sync, whatever the number of reviews.
- There is no users table: the Firebase uid is the user id.
- There are no foreign keys or cascades.

Known ceilings: a brand-new device pulls everything in one response, with no pagination. That is fine up to tens of thousands of cards. Conflicts resolve per row, so two devices editing different fields of the same card offline keep only the later edit. Last-write-wins trusts the device clock.

## Endpoint

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/sync` | `{since, folders?, cards?, notes?, activity?}` | `{cursor, folders, cards, notes, activity}` |

It needs `Authorization: Bearer <Firebase ID token>`. Errors are `{ "error": "..." }`, with 400 for bad rows, 401 without a valid token, and 413 for more than 500 rows. The row columns are in `migrations/0001_init.sql`; `tags` travels as a JSON string.
# mindkeep_backend
