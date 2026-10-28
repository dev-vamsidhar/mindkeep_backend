// Firebase Auth: the client signs in (email/password or Google) and sends its ID token as a bearer token.
// We verify it ourselves per https://firebase.google.com/docs/auth/admin/verify-id-tokens (firebase-admin doesn't run on Workers).
const KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const SKEW_S = 300;

export type Claims = { sub: string; email?: string; name?: string; aud: string; iss: string; exp: number; iat: number; auth_time: number };

const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = (s: string) => JSON.parse(new TextDecoder().decode(dec(s)));

let cache: { keys: Record<string, JsonWebKey>; until: number } | undefined;
async function googleKeys() {
  if (cache && cache.until > Date.now()) return cache.keys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`Fetching Firebase keys failed: ${res.status}`);
  const { keys } = await res.json<{ keys: (JsonWebKey & { kid: string })[] }>();
  const maxAge = Number(res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
  cache = { keys: Object.fromEntries(keys.map((k) => [k.kid, k])), until: Date.now() + maxAge * 1000 };
  return cache.keys;
}

// Returns the token's claims, or null if it is invalid. `emulator` accepts the unsigned tokens the Firebase Auth emulator issues.
export async function verifyIdToken(token: string, projectId: string, opts: { emulator?: boolean; keys?: Record<string, JsonWebKey> } = {}): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, c: Claims;
  try { [header, c] = [parse(parts[0]), parse(parts[1])]; } catch { return null; }

  if (!(opts.emulator && header.alg === "none")) {
    if (header.alg !== "RS256" || !header.kid) return null;
    const jwk = (opts.keys ?? (await googleKeys()))[header.kid];
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    let sig: Uint8Array;
    try { sig = dec(parts[2]); } catch { return null; }
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) return null;
  }

  const now = Date.now() / 1000;
  const ok = c.aud === projectId && c.iss === `https://securetoken.google.com/${projectId}` &&
    typeof c.sub === "string" && c.sub.length > 0 && c.sub.length <= 128 &&
    c.exp > now - SKEW_S && c.iat < now + SKEW_S && c.auth_time < now + SKEW_S;
  return ok ? c : null;
}

export async function sessionUser(env: { FIREBASE_PROJECT_ID: string; FIREBASE_AUTH_EMULATOR?: string }, req: Request) {
  const token = req.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const c = await verifyIdToken(token, env.FIREBASE_PROJECT_ID, { emulator: env.FIREBASE_AUTH_EMULATOR === "true" });
  return c && { id: c.sub };
}
