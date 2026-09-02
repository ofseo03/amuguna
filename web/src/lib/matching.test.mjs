import assert from "node:assert/strict";
import test from "node:test";
import { encodeMatchCursor, runMatch } from "./matching.ts";
import { validateCursor } from "./validation.ts";

test("opaque match cursor round-trips its score/id keyset", () => {
  const encoded = encodeMatchCursor({ score: 0.625, id: 42 });
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(validateCursor(encoded), { ok: true, value: { score: 0.625, id: 42 } });
});

test("match cursor rejects malformed or unsafe keyset values", () => {
  assert.equal(validateCursor("not/base64").ok, false);
  const invalid = Buffer.from(JSON.stringify({ score: 1.5, id: 42 })).toString("base64url");
  assert.equal(validateCursor(invalid).ok, false);
  const extra = Buffer.from(JSON.stringify({ score: 0.5, id: 42, x: true })).toString("base64url");
  assert.equal(validateCursor(extra).ok, false);
});

test("P1/P2/P3 golden personas keep expected programs in the final result", async () => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    MOCK_EMBEDDINGS: process.env.MOCK_EMBEDDINGS,
  };
  delete process.env.DATABASE_URL;
  process.env.EMBEDDING_PROVIDER = "mock";
  process.env.MOCK_EMBEDDINGS = "1";
  try {
    const cases = [
      {
        profile: { age: 28, gender: "F", occupation: "employee_office", sidoCode: "11", sigunguCode: "11620", incomeDecile: 3, medianIncomePercent: null },
        query: "보증금 올려달래서 대출 알아봐요",
        expected: ["중소기업 취업청년 전월세보증금 대출", "버팀목 전세자금대출", "청년월세 특별지원"],
      },
      {
        profile: { age: 41, gender: "M", occupation: "self_employed", sidoCode: "26", sigunguCode: "26350", incomeDecile: 5, medianIncomePercent: null },
        query: "가게 확장하려는데 자금이 필요해요",
        expected: ["소상공인 정책자금 (성장기반자금)", "부산신용보증재단 보증부 대출", "노란우산공제 가입지원"],
      },
      {
        profile: { age: 67, gender: "F", occupation: "jobseeker", sidoCode: "46", sigunguCode: "46150", incomeDecile: 1, medianIncomePercent: null },
        query: null,
        expected: ["기초연금", "긴급복지지원 생계지원금", "농어촌 주거환경 개선 융자"],
      },
    ];
    for (const persona of cases) {
      const result = await runMatch({ ...persona, form: "all", cursor: null });
      const titles = result.cards.map((card) => card.program.title);
      for (const title of persona.expected) assert.ok(titles.includes(title), title);
    }

    const p3 = await runMatch({ ...cases[2], form: "all", cursor: null });
    assert.equal(p3.degraded, false);
    assert.ok(p3.cards.slice(0, 5).every((card) => card.program.title !== "예·적금 금리 비교공시"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// §7.6 — 근접 탈락은 자격 축 안내이므로 자유입력(의도)에 영향받지 않아야 한다.
// 질의 유무에 따라 다섯 건의 구성·순서가 달라지면 데모와 DB 모드가 서로 다른 목록을 내게 된다.
test("near-miss list is independent of the free-text query", async () => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    MOCK_EMBEDDINGS: process.env.MOCK_EMBEDDINGS,
  };
  delete process.env.DATABASE_URL;
  process.env.EMBEDDING_PROVIDER = "mock";
  process.env.MOCK_EMBEDDINGS = "1";
  try {
    const profile = { age: 28, gender: "F", occupation: "employee_office", sidoCode: "11", sigunguCode: "11620", incomeDecile: 3, medianIncomePercent: null };
    const withQuery = await runMatch({ profile, query: "보증금 올려달래서 대출 알아봐요", form: "all", cursor: null });
    const without = await runMatch({ profile, query: null, form: "all", cursor: null });
    assert.equal(withQuery.relaxation, "none");
    assert.deepEqual(
      withQuery.nearMisses.map((n) => [n.program.id, n.score]),
      without.nearMisses.map((n) => [n.program.id, n.score]),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
