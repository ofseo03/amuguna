import assert from "node:assert/strict";
import test from "node:test";

import { generateLiveAnswer } from "./live-answer.ts";

function cards(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    reason: `PRIVATE_REASON_${index + 1}`,
    profile: `PRIVATE_PROFILE_${index + 1}`,
    program: {
      title: `지원 사업 ${index + 1}`,
      issuer: `기관 ${index + 1}`,
      summary: `요약 ${index + 1}`,
      benefit_amount_text: `${index + 1}백만원`,
      ends_at: "2026-12-31",
      is_always_open: false,
      source_url: `https://example.test/${index + 1}`,
      body_text: `PRIVATE_BODY_${index + 1}`,
    },
  }));
}

const initialSearch = {
  query: "창업 자금이 필요해요",
  form: "all",
  cursor: null,
  cards: cards(),
};

test("최초 검색은 허용된 상위 5건만 OpenRouter에 한 번 보낸다", async () => {
  let calls = 0;
  let request;
  const fetchImpl = async (url, init) => {
    calls++;
    request = { url, init };
    return Response.json({ choices: [{ message: { content: "[1] 공고를 먼저 확인해 보세요." } }] });
  };

  const result = await generateLiveAnswer(initialSearch, fetchImpl, "secret-key", "test/model");

  assert.deepEqual(result, { text: "[1] 공고를 먼저 확인해 보세요.", status: "ok" });
  assert.equal(calls, 1);
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer secret-key");

  const payload = JSON.parse(request.init.body);
  assert.equal(payload.model, "test/model");
  assert.equal(payload.stream, false);
  assert.equal(payload.max_completion_tokens, 400);
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /창업 자금이 필요해요/);
  assert.match(serialized, /지원 사업 5/);
  assert.doesNotMatch(serialized, /지원 사업 6/);
  assert.doesNotMatch(serialized, /PRIVATE_PROFILE|PRIVATE_REASON|PRIVATE_BODY|body_text/);
});

test("검색어·전체 첫 페이지·결과 중 하나라도 없으면 요청하지 않는다", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("호출되면 안 됨");
  };
  const cases = [
    { ...initialSearch, query: null },
    { ...initialSearch, form: "loan" },
    { ...initialSearch, cursor: { score: 0.5, id: 1 } },
    { ...initialSearch, cards: [] },
  ];

  for (const input of cases) {
    assert.deepEqual(await generateLiveAnswer(input, fetchImpl, "key"), {
      text: null,
      status: "not_requested",
    });
  }
  assert.equal(calls, 0);
});

test("키 누락과 OpenRouter 장애는 unavailable 상태로 끝난다", async () => {
  let calls = 0;
  const missingKey = await generateLiveAnswer(initialSearch, async () => {
    calls++;
    return new Response();
  }, "");
  assert.deepEqual(missingKey, { text: null, status: "unavailable" });
  assert.equal(calls, 0);

  const failures = [
    async () => new Response("busy", { status: 503 }),
    async () => { throw new DOMException("timed out", "TimeoutError"); },
    async () => new Response("not json", { status: 200 }),
  ];
  for (const fetchImpl of failures) {
    assert.deepEqual(await generateLiveAnswer(initialSearch, fetchImpl, "key"), {
      text: null,
      status: "unavailable",
    });
  }
});

test("빈 값·한국어가 아닌 값·1200자 초과 답변은 노출하지 않는다", async () => {
  for (const content of [" ", "English only", "가".repeat(1201)]) {
    const result = await generateLiveAnswer(
      initialSearch,
      async () => Response.json({ choices: [{ message: { content } }] }),
      "key",
    );
    assert.deepEqual(result, { text: null, status: "unavailable" });
  }

  const boundary = "가".repeat(1200);
  assert.deepEqual(
    await generateLiveAnswer(
      initialSearch,
      async () => Response.json({ choices: [{ message: { content: boundary } }] }),
      "key",
    ),
    { text: boundary, status: "ok" },
  );
});
