import { test } from "node:test";
import assert from "node:assert/strict";
import { allowOrigin } from "./index.ts";

test("allows listed origins and wildcard subdomains only", () => {
  const list = "http://localhost:3000, https://mindkeep.pages.dev, https://*.mindkeep.pages.dev";
  assert.equal(allowOrigin("http://localhost:3000", list), "http://localhost:3000");
  assert.equal(allowOrigin("https://mindkeep.pages.dev", list), "https://mindkeep.pages.dev");
  assert.equal(allowOrigin("https://abc123.mindkeep.pages.dev", list), "https://abc123.mindkeep.pages.dev");
  for (const bad of ["https://evil.com", "https://mindkeep.pages.dev.evil.com", "https://a.b.mindkeep.pages.dev", "https://evil.com/.mindkeep.pages.dev", null])
    assert.equal(allowOrigin(bad, list), "", String(bad));
});
