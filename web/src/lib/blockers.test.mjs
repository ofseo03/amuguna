import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EMBEDDING_DIM, embedQuery, mockEmbed } from "./embedding.ts";

test("email conflict cannot update another profile", async () => {
  const route = await readFile(
    new URL("../app/api/subscribe/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(route, /UPDATE profiles[\s\S]*WHERE lower\(email\)/);
});

test("matching drops every degraded query vector", async () => {
  const matching = await readFile(new URL("./matching.ts", import.meta.url), "utf8");
  assert.match(matching, /qvec = r\.degraded \? null : r\.vector/);
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
