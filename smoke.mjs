// End-to-end sync check against `npm run dev` (local D1, FIREBASE_AUTH_EMULATOR=true in .dev.vars).
// Usage: node smoke.mjs [base-url]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "http://localhost:8787") + "/api/sync";
const project = readFileSync(new URL("wrangler.toml", import.meta.url), "utf8").match(/FIREBASE_PROJECT_ID = "(.+)"/)[1];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const t = Math.floor(Date.now() / 1000);
// Unsigned token in the Firebase Auth emulator's format.
const token = (sub) => `${b64({ alg: "none" })}.${b64({ sub, aud: project, iss: `https://securetoken.google.com/${project}`, iat: t, exp: t + 3600, auth_time: t })}.`;
const sync = async (sub, body, status = 200) => {
  const res = await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${token(sub)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, status, await res.clone().text());
  return res.json();
};

const user = `u${t}`;
const card = (front, updated_at) => ({ id: "c1", folder_id: "f1", front, back: "b", tags: "[]", starred: 0, state: 0, due: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last_review: null, created_at: 1, updated_at, deleted: 0 });

// Device A creates a folder and a card.
const a1 = await sync(user, { since: 0, folders: [{ id: "f1", name: "DSA", dot: "bg-primary", updated_at: 1000, deleted: 0 }], cards: [card("A1", 1000)], activity: [{ device: "A", day: "2026-10-27", count: 3 }] });
assert.equal(a1.cards.length, 0); // the pull runs before the push

// Device B catches up from scratch.
const b1 = await sync(user, { since: 0 });
assert.equal(b1.cards[0].front, "A1");
assert.equal(b1.activity[0].count, 3);

// B edits later than A; A's stale edit loses (last write wins), and A then receives B's version.
await sync(user, { since: b1.cursor, cards: [card("B edit", 3000)] });
const a2 = await sync(user, { since: a1.cursor, cards: [card("A stale", 2000)] });
assert.equal(a2.cards.find((c) => c.id === "c1").front, "B edit");
const a3 = await sync(user, { since: a2.cursor });
assert.ok(a3.cards.every((c) => c.front === "B edit"), "stale push must not win");

// Nothing changed -> nothing to pull except our own echo.
const a4 = await sync(user, { since: a3.cursor });
assert.equal(a4.cards.length + a4.folders.length + a4.activity.length, 0);

// Another user can't see or overwrite this user's rows.
const other = await sync(`x${t}`, { since: 0, cards: [card("hijack", 9999)] });
assert.equal(other.cards.length, 0);
assert.equal((await sync(user, { since: 0 })).cards[0].front, "B edit");

// Sub-folders: parent_id round-trips, and a folder can't be its own parent.
await sync(user, { folders: [{ id: "f2", name: "Graphs", dot: "bg-primary", parent_id: "f1", updated_at: 4000, deleted: 0 }] });
assert.equal((await sync(user, { since: 0 })).folders.find((f) => f.id === "f2").parent_id, "f1");
await sync(user, { folders: [{ id: "f3", name: "Loop", dot: "bg-primary", parent_id: "f3", updated_at: 1, deleted: 0 }] }, 400);

// Notes and note folders round-trip.
await sync(user, { folders: [{ id: "n1", name: "Journal", dot: "bg-primary", parent_id: null, kind: "notes", updated_at: 5000, deleted: 0 }], notes: [{ id: "note1", folder_id: "n1", title: "Day 1", body: "# Hi\n- [ ] task [[Day 2]] #idea", created_at: 1, updated_at: 5000, deleted: 0 }] });
const n = await sync(user, { since: 0 });
assert.equal(n.folders.find((f) => f.id === "n1").kind, "notes");
assert.equal(n.folders.find((f) => f.id === "f1").kind, "cards");
assert.match(n.notes[0].body, /\[\[Day 2\]\]/);
await sync(user, { folders: [{ id: "n2", name: "x", dot: "x", kind: "photos", updated_at: 1, deleted: 0 }] }, 400);

// Bad input and missing auth.
await sync(user, { cards: [{ ...card("x", 1), due: "soon" }] }, 400);
await sync(user, { cards: Array(501).fill(card("x", 1)) }, 413);
assert.equal((await fetch(base, { method: "POST", body: "{}" })).status, 401);
console.log("smoke OK");
