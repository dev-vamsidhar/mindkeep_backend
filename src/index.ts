import { sessionUser } from "./auth.ts";

type Env = { DB: D1Database; ALLOWED_ORIGIN: string; FIREBASE_PROJECT_ID: string; FIREBASE_AUTH_EMULATOR?: string };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_ROWS = 500; // per request, across all tables; the client sends bigger backlogs in chunks
// D1's own clock, so every Worker stamps rows on one timeline.
const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

// Column -> validator. Each one returns the value to bind, or throws.
type Check = (v: unknown, col: string) => unknown;
const str = (max: number): Check => (v, col) => {
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${col} must be a string of at most ${max} chars`);
  return v;
};
const num: Check = (v, col) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${col} must be a number`);
  return v;
};
const nullableNum: Check = (v, col) => (v === null || v === undefined ? null : num(v, col));
const flag: Check = (v, col) => {
  if (v !== 0 && v !== 1 && v !== true && v !== false) throw new HttpError(400, `${col} must be 0 or 1`);
  return +v;
};
const id = str(64);
const nullableId: Check = (v, col) => (v === null || v === undefined ? null : id(v, col));
const kind: Check = (v, col) => {
  if (v === undefined || v === null) return "cards";
  if (v !== "cards" && v !== "notes") throw new HttpError(400, `${col} must be "cards" or "notes"`);
  return v;
};
const day: Check = (v, col) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${col} must be YYYY-MM-DD`);
  return v;
};

const TABLES = {
  folders: {
    key: ["id"],
    cols: { id, name: str(200), dot: str(64), parent_id: nullableId, kind, updated_at: num, deleted: flag },
    win: "excluded.updated_at > folders.updated_at", // last write wins
  },
  cards: {
    key: ["id"],
    cols: {
      id, folder_id: id, front: str(20_000), back: str(20_000), tags: str(4_000), starred: flag,
      state: num, due: num, stability: num, difficulty: num, reps: num, lapses: num, last_review: nullableNum,
      created_at: num, updated_at: num, deleted: flag,
    },
    win: "excluded.updated_at > cards.updated_at",
  },
  notes: {
    key: ["id"],
    cols: { id, folder_id: id, title: str(300), body: str(200_000), created_at: num, updated_at: num, deleted: flag },
    win: "excluded.updated_at > notes.updated_at",
  },
  activity: {
    key: ["device", "day"],
    cols: { device: id, day, count: num },
    win: "excluded.count > activity.count", // each device only ever raises its own counts
  },
} as const;
type Table = keyof typeof TABLES;

// POST /api/sync { since, folders?, cards?, notes?, activity? } -> { cursor, folders, cards, notes, activity }
// Pushes the client's changed rows and returns every row changed since `since`, in one D1 batch (one transaction).
async function sync(req: Request, env: Env, userId: string) {
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { throw new HttpError(400, "Body must be JSON"); }
  if (!b || typeof b !== "object") throw new HttpError(400, "Body must be a JSON object");
  const since = b.since === undefined ? 0 : num(b.since, "since") as number;

  const db = env.DB;
  const pushes: D1PreparedStatement[] = [];
  let total = 0;
  for (const [name, t] of Object.entries(TABLES) as [Table, (typeof TABLES)[Table]][]) {
    const rows = b[name] ?? [];
    if (!Array.isArray(rows)) throw new HttpError(400, `${name} must be an array`);
    if ((total += rows.length) > MAX_ROWS) throw new HttpError(413, `At most ${MAX_ROWS} rows per sync`);
    const cols = Object.keys(t.cols);
    const sql = `INSERT INTO ${name} (user_id, ${cols.join(", ")}, synced_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ${NOW})
      ON CONFLICT (user_id, ${t.key.join(", ")}) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, synced_at = excluded.synced_at
      WHERE ${t.win}`;
    const stmt = db.prepare(sql);
    for (const r of rows) {
      if (!r || typeof r !== "object") throw new HttpError(400, `${name} rows must be objects`);
      if (name === "folders" && r.parent_id != null && r.parent_id === r.id) throw new HttpError(400, "A folder can't be its own parent");
      pushes.push(stmt.bind(userId, ...Object.entries(t.cols).map(([c, check]) => (check as Check)((r as Record<string, unknown>)[c], c))));
    }
  }

  // Pull first, so the cursor and the pulled rows come from the same moment; then apply the pushes.
  // Rows we push now get synced_at >= cursor, so they echo back once on the next pull. The client ignores them.
  const pull = (name: Table) => db.prepare(`SELECT ${Object.keys(TABLES[name].cols).join(", ")} FROM ${name} WHERE user_id = ? AND synced_at >= ?`).bind(userId, since);
  const [cursor, folders, cards, notes, activity] = await db.batch([
    db.prepare(`SELECT ${NOW} AS now`), pull("folders"), pull("cards"), pull("notes"), pull("activity"), ...pushes,
  ]);
  return Response.json({
    cursor: (cursor.results[0] as { now: number }).now,
    folders: folders.results,
    cards: cards.results,
    notes: notes.results,
    activity: activity.results,
  });
}

async function handle(req: Request, env: Env) {
  const path = new URL(req.url).pathname;
  if (path !== "/api/sync") throw new HttpError(404, "Not found");
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const user = await sessionUser(env, req);
  if (!user) throw new HttpError(401, "Not signed in");
  return sync(req, env, user.id);
}

// ALLOWED_ORIGIN is a comma-separated list. A "*" matches one subdomain label, so
// "https://*.mindkeep.pages.dev" also allows Pages preview deploys.
export function allowOrigin(origin: string | null, allowed: string) {
  if (!origin) return "";
  const match = (pattern: string) =>
    new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`, "i").test(origin);
  return allowed.split(",").some(match) ? origin : "";
}

export default {
  async fetch(req: Request, env: Env) {
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin(req.headers.get("Origin"), env.ALLOWED_ORIGIN),
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await handle(req, env);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = e instanceof HttpError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: "Internal error" }, { status: 500 });
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
