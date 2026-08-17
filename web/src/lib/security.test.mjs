import assert from "node:assert/strict";
import test from "node:test";

import { externalHttpUrl } from "./format.ts";
import { sslOption } from "./db.ts";
import { deserializeSessionId, serializeSessionId, sessionSecret } from "./session.ts";

test("production requires a strong session secret", () => {
  assert.throws(
    () => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "too-short" }),
    /32자 이상/,
  );
  assert.equal(
    sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) }),
    "x".repeat(32),
  );
});

test("session ids are strict UUIDv4 values protected by HMAC", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const signed = serializeSessionId(id);
  assert.equal(deserializeSessionId(signed), id);
  assert.equal(deserializeSessionId(id), null);
  assert.equal(deserializeSessionId(signed.replace(id, "0f8fad5b-d9cb-469f-a165-70867728950f")), null);
  assert.throws(() => serializeSessionId("00000000-0000-0000-0000-000000000000"), /invalid session/);
});

test("external links only allow http and https", () => {
  assert.equal(externalHttpUrl("https://example.test/path"), "https://example.test/path");
  assert.equal(externalHttpUrl("javascript:alert(1)"), null);
  assert.equal(externalHttpUrl("data:text/html,bad"), null);
  assert.equal(externalHttpUrl("not a url"), null);
});

test("database TLS defaults do not override explicit or local DSNs", () => {
  assert.equal(sslOption("postgres://localhost/app", {}), undefined);
  assert.equal(sslOption("postgres://db.example/app?sslmode=disable", {}), undefined);
  assert.equal(sslOption("host=/var/run/postgresql dbname=app", {}), undefined);
  assert.equal(sslOption("postgres://db.example/app", {}), "verify-full");
});
