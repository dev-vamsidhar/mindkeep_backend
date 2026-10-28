import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyIdToken } from "./auth.ts";

const P = "mindkeep-test";
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const good = { sub: "uid1", email: "a@b.co", aud: P, iss: `https://securetoken.google.com/${P}`, iat: now, exp: now + 3600, auth_time: now };

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const keys = { k1: await crypto.subtle.exportKey("jwk", publicKey) };

async function sign(claims: object, kid = "k1") {
  const input = `${b64u(JSON.stringify({ alg: "RS256", kid }))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input))))}`;
}

test("accepts a valid token", async () => {
  assert.equal((await verifyIdToken(await sign(good), P, { keys }))?.sub, "uid1");
});

test("rejects bad tokens", async () => {
  const tampered = (await sign(good)).split(".");
  tampered[1] = b64u(JSON.stringify({ ...good, sub: "attacker" }));
  for (const t of [
    tampered.join("."),
    await sign(good, "unknown-kid"),
    await sign({ ...good, aud: "other" }),
    await sign({ ...good, iss: "https://securetoken.google.com/other" }),
    await sign({ ...good, exp: now - 3600 }),
    await sign({ ...good, sub: "" }),
    "garbage",
  ]) assert.equal(await verifyIdToken(t, P, { keys }), null, t.slice(0, 40));
});

test("unsigned tokens only pass in emulator mode", async () => {
  const unsigned = `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(good))}.`;
  assert.equal(await verifyIdToken(unsigned, P, { keys }), null);
  assert.equal((await verifyIdToken(unsigned, P, { emulator: true }))?.sub, "uid1");
});
