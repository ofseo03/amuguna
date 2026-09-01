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

test("an explicit sslmode remains controlled by the connection string", () => {
  assert.equal(
    sslOption(
      "postgresql://postgres.ref:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require",
      {},
    ),
    undefined,
  );
});
