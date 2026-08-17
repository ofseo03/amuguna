import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EMBEDDING_DIM, embedQuery, mockEmbed } from "./embedding.ts";
import { isOpen } from "./eligibility.ts";

test("the profile endpoint keeps personal input out of the database", async () => {
  const route = await readFile(
    new URL("../app/api/profile/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(route, /INSERT INTO profiles/);
  assert.doesNotMatch(route, /getSql|isDbConfigured/);
});

test("matching drops every degraded query vector", async () => {
  const matching = await readFile(new URL("./matching.ts", import.meta.url), "utf8");
  assert.match(matching, /qvec = r\.degraded \? null : r\.vector/);
  assert.match(matching, /active_vector_space/);
  assert.match(matching, /vectorSpace\(\)/);
});

test("application windows use the Korean calendar date in every matching path", async () => {
  const now = new Date("2026-08-14T15:30:00Z"); // 2026-08-15 00:30 KST
  const program = { status: "active", starts_at: "2026-08-15", ends_at: "2026-08-15" };
  assert.equal(isOpen(program, now), true);
  assert.equal(isOpen({ ...program, starts_at: "2026-08-16" }, now), false);
  assert.equal(isOpen({ ...program, starts_at: null, ends_at: "2026-08-14" }, now), false);
  assert.equal(isOpen({ ...program, status: "expired" }, now), false);

  const baseMigration = await readFile(
    new URL("../../../db/migrations/0002_match.sql", import.meta.url),
    "utf8",
  );
  const upgradeMigration = await readFile(
    new URL("../../../db/migrations/0008_application_window.sql", import.meta.url),
    "utf8",
  );
  const matching = await readFile(new URL("./matching.ts", import.meta.url), "utf8");
  const predicate = /p\.starts_at IS NULL OR p\.starts_at <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/g;
  assert.equal(baseMigration.match(predicate)?.length, 2);
  assert.equal(upgradeMigration.match(predicate)?.length, 2);
  assert.equal(matching.match(predicate)?.length, 1);
});

test("mock stays usable and real-provider failures cannot produce a mock query vector", async () => {
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  const originalKey = process.env.EMBEDDING_API_KEY;
  const originalFetch = globalThis.fetch;

  try {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_API_KEY;
    assert.deepEqual((await embedQuery("주거 지원")).vector, mockEmbed("주거 지원"));

    process.env.EMBEDDING_PROVIDER = "openai";
    assert.equal((await embedQuery("주거 지원")).vector, null);

    process.env.EMBEDDING_API_KEY = "test";
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal((await embedQuery("주거 지원")).vector, null);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ embedding: Array(EMBEDDING_DIM).fill(0) }] }));
    assert.equal((await embedQuery("주거 지원")).vector, null);
  } finally {
    if (originalProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  }
});
