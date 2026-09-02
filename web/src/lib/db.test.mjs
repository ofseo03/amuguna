import assert from "node:assert/strict";
import test from "node:test";
import { sslOption } from "./db.ts";

test("Supabase pooler uses the bundled official CA without a file path", () => {
  const ssl = sslOption(
    "postgresql://postgres.ref:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres",
    {},
  );

  assert.equal(typeof ssl, "object");
  assert.equal(ssl.rejectUnauthorized, true);
  assert.match(ssl.ca, /^-----BEGIN CERTIFICATE-----/);
});

// postgres.js 는 sslmode=require 를 rejectUnauthorized:false 로 해석한다.
// Supabase 가 주는 기본 DSN 이 정확히 이 형태이므로, 그대로 넘기면 CA 검증이 빠진다.
test("sslmode=require on a Supabase DSN still pins the bundled CA", () => {
  const ssl = sslOption(
    "postgresql://postgres.ref:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require",
    {},
  );
  assert.equal(typeof ssl, "object");
  assert.equal(ssl.rejectUnauthorized, true);
  assert.match(ssl.ca, /^-----BEGIN CERTIFICATE-----/);
});

test("other verifying sslmodes are upgraded, only disable opts out", () => {
  for (const mode of ["prefer", "allow", "verify-ca", "verify-full", "REQUIRE"]) {
    assert.equal(
      sslOption(`postgres://db.example/app?sslmode=${mode}`, {}),
      "verify-full",
      mode,
    );
  }
  assert.equal(sslOption("postgres://db.example/app?sslmode=disable", {}), false);
  assert.equal(sslOption("postgres://db.example/app?sslmode=false", {}), false);
  // 로컬이라도 sslmode 를 명시했으면 그 뜻대로 검증한다
  assert.equal(sslOption("postgres://localhost/app?sslmode=require", {}), "verify-full");
});
