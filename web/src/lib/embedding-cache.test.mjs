/**
 * 질의 임베딩 캐시 (SPEC §7.2, §8 성능).
 *
 * 검색 1회 = 임베딩 API 과금 1회다. 온보딩의 예시 문구 4종은 누르면 그대로 전송되므로
 * 같은 문장이 사용자 수만큼 반복된다 — 캐시 없이는 그 전부가 과금이다.
 *
 * 가장 중요한 계약은 **모델을 바꾸면 캐시가 오염되지 않는 것**이다. 벡터 공간이 달라지면
 * 예전 벡터로 새 색인을 검색하게 되고, 유사도가 틀리는 게 아니라 조용히 무의미해진다.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMBEDDING_DIM,
  OPENAI_MODEL,
  VOYAGE_MODEL,
  clearQueryCache,
  embedQuery,
  normalizeQuery,
  queryCacheKey,
  queryCacheSize,
} from "./embedding.ts";

const QUERY = "보증금 올려달래서 대출 알아봐요";

function fakeEmbeddingServer() {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    // 호출마다 다른 벡터를 돌려준다 — 캐시 적중과 재계산을 값으로도 구분할 수 있게
    const hot = calls % EMBEDDING_DIM;
    const embedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === hot ? 1 : 0.001));
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    get calls() {
      return calls;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  })();
}

test("질의 정규화는 표기 차이를 흡수한다", () => {
  assert.equal(normalizeQuery("  보증금   대출 "), "보증금 대출");
  assert.equal(normalizeQuery("Jeonse LOAN"), "jeonse loan");
  assert.equal(normalizeQuery("보증금\n\n대출"), "보증금 대출");
});

test("캐시 키에 provider 와 모델명이 들어간다", () => {
  const voyage = queryCacheKey(QUERY, `voyage:${VOYAGE_MODEL}`);
  const openai = queryCacheKey(QUERY, `openai:${OPENAI_MODEL}`);
  assert.notEqual(voyage, openai, "모델이 달라도 같은 키가 나오면 벡터 공간이 섞인다");
  assert.match(voyage, new RegExp(VOYAGE_MODEL));
  assert.match(openai, new RegExp(OPENAI_MODEL));
  // 정규화된 질의로 키를 잡는다
  assert.equal(queryCacheKey("  보증금  대출 ", "x"), queryCacheKey("보증금 대출", "x"));
});

test("같은 질의는 임베딩 API 를 한 번만 부른다", async () => {
  clearQueryCache();
  const server = fakeEmbeddingServer();
  try {
    await withEnv({ EMBEDDING_PROVIDER: "openai", EMBEDDING_API_KEY: "k" }, async () => {
      const first = await embedQuery(QUERY);
      assert.equal(first.degraded, false);
      assert.equal(server.calls, 1);

      // 같은 문장, 그리고 표기만 다른 같은 문장
      const second = await embedQuery(QUERY);
      const third = await embedQuery(`  ${QUERY}  `);
      assert.equal(server.calls, 1, "캐시가 적중하지 않았다");
      assert.deepEqual(Array.from(second.vector), Array.from(first.vector));
      assert.deepEqual(Array.from(third.vector), Array.from(first.vector));

      // 다른 문장은 다시 부른다
      await embedQuery("가게 확장하려는데 자금이 필요해요");
      assert.equal(server.calls, 2);
    });
  } finally {
    server.restore();
  }
});

test("provider 를 바꾸면 캐시가 재사용되지 않는다", async () => {
  clearQueryCache();
  const server = fakeEmbeddingServer();
  try {
    await withEnv({ EMBEDDING_PROVIDER: "openai", EMBEDDING_API_KEY: "k" }, () => embedQuery(QUERY));
    assert.equal(server.calls, 1);
    // 같은 문장이지만 벡터 공간이 다르다 — 반드시 새로 계산해야 한다
    await withEnv({ EMBEDDING_PROVIDER: "voyage", EMBEDDING_API_KEY: "k" }, () => embedQuery(QUERY));
    assert.equal(server.calls, 2, "모델이 바뀌었는데 옛 벡터를 재사용했다");
  } finally {
    server.restore();
  }
});

test("실패한 임베딩은 캐시하지 않는다", async () => {
  clearQueryCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("nope", { status: 503 });
  };
  try {
    await withEnv({ EMBEDDING_PROVIDER: "openai", EMBEDDING_API_KEY: "k" }, async () => {
      const first = await embedQuery(QUERY);
      assert.equal(first.degraded, true);
      assert.equal(first.vector, null);
      // 실패를 캐시하면 일시적 장애가 캐시 수명만큼 길어진다
      await embedQuery(QUERY);
      assert.equal(calls, 2);
      assert.equal(queryCacheSize(), 0);
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("캐시는 무한히 자라지 않는다", async () => {
  clearQueryCache();
  const server = fakeEmbeddingServer();
  try {
    await withEnv({ EMBEDDING_PROVIDER: "openai", EMBEDDING_API_KEY: "k" }, async () => {
      for (let i = 0; i < 600; i++) await embedQuery(`질의 ${i}`);
      assert.ok(queryCacheSize() <= 500, `캐시가 ${queryCacheSize()}개까지 늘었다`);
    });
  } finally {
    server.restore();
    clearQueryCache();
  }
});

test("mock provider 는 캐시를 쓰지 않는다", async () => {
  clearQueryCache();
  await withEnv({ EMBEDDING_PROVIDER: "mock" }, async () => {
    const r = await embedQuery(QUERY);
    assert.equal(r.provider, "mock");
    assert.equal(r.degraded, false);
    // 순수 계산이라 캐시할 이유가 없다 — 메모리만 쓴다
    assert.equal(queryCacheSize(), 0);
  });
});
