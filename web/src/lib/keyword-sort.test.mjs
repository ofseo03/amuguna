import assert from "node:assert/strict";
import test from "node:test";
import {
  FIELD_WEIGHTS,
  MAX_SORT_TOKENS,
  blendSortScore,
  keywordScore,
  sortTokens,
} from "./keyword-sort.ts";
import { MAX_SORT_QUERY_LEN, validateSortQuery } from "./validation.ts";
import { runMatch } from "./matching.ts";

const P1 = {
  age: 28,
  gender: "F",
  occupation: "employee_office",
  sidoCode: "11",
  sigunguCode: "11620",
  incomeDecile: 3,
  medianIncomePercent: null,
};

/** 데모 백엔드로만 도는 환경 — DB·임베딩 키 없이 결정형으로 검증한다. */
async function demoMatch(input) {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    MOCK_EMBEDDINGS: process.env.MOCK_EMBEDDINGS,
  };
  delete process.env.DATABASE_URL;
  process.env.EMBEDDING_PROVIDER = "mock";
  process.env.MOCK_EMBEDDINGS = "1";
  try {
    return await runMatch({ profile: P1, query: null, form: "all", cursor: null, ...input });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const program = (over = {}) => ({
  title: "청년 전세자금 대출",
  summary: "보증금을 빌려드립니다",
  issuer: "국토교통부",
  benefit_amount_text: "최대 1억원",
  ...over,
});

test("검색어는 구두점을 걷어내고 낱말로 쪼갠다", () => {
  assert.deepEqual(sortTokens("  전세,  청년! "), ["전세", "청년"]);
  assert.deepEqual(sortTokens("Youth HOUSING"), ["youth", "housing"]);
  // 같은 낱말을 두 번 적어도 평균이 흐트러지지 않는다
  assert.deepEqual(sortTokens("전세 전세 전세"), ["전세"]);
  assert.deepEqual(sortTokens("!!! ??? ..."), []);
  assert.deepEqual(sortTokens(null), []);
});

test("한 글자짜리는 버리되, 전부 한 글자면 그대로 쓴다", () => {
  // "집" 은 조사·어미와 겹쳐 아무 데나 걸리지만, 아무것도 정렬하지 않는 것보다는 낫다
  assert.deepEqual(sortTokens("전세 집"), ["전세"]);
  assert.deepEqual(sortTokens("집"), ["집"]);
});

test("낱말 수는 상한에서 끊는다", () => {
  const many = Array.from({ length: MAX_SORT_TOKENS + 5 }, (_, i) => `낱말${i}`).join(" ");
  assert.equal(sortTokens(many).length, MAX_SORT_TOKENS);
});

test("낱말 하나의 점수는 가장 앞자리 하나이고, 합산하지 않는다", () => {
  // 제목·요약 양쪽에 있어도 제목 점수 하나다
  assert.equal(keywordScore(program({ summary: "전세 보증금" }), ["전세"]), FIELD_WEIGHTS.title);
  assert.equal(keywordScore(program({ title: "월세 지원" }), ["전세"]), 0);
  assert.equal(keywordScore(program({ title: "월세 지원" }), ["보증금"]), FIELD_WEIGHTS.summary);
  assert.equal(keywordScore(program({ title: "월세 지원" }), ["국토"]), FIELD_WEIGHTS.issuer);
  assert.equal(keywordScore(program({ title: "월세 지원" }), ["1억원"]), FIELD_WEIGHTS.benefit);
});

test("여러 낱말은 평균이라 전부 맞은 건이 일부만 맞은 건보다 위다", () => {
  const both = keywordScore(program(), ["청년", "전세"]);
  const one = keywordScore(program({ title: "청년 월세 지원" }), ["청년", "전세"]);
  assert.equal(both, 1);
  assert.equal(one, 0.5);
  assert.ok(both > one);
  assert.equal(keywordScore(program(), []), 0);
});

test("검색어가 §7.4 스코어보다 항상 먼저 순서를 정한다", () => {
  // 검색어 점수 차이는 최소 0.01 인데, 그 차이가 §7.4 스코어 0 대 1 의 차이보다 커야 한다.
  const weakKeywordBestScore = blendSortScore(1, 0.35, true);
  const strongKeywordWorstScore = blendSortScore(0, 0.36, true);
  assert.ok(strongKeywordWorstScore > weakKeywordBestScore);
  // 검색어가 같으면 그때만 §7.4 스코어가 정한다
  assert.ok(blendSortScore(0.9, 0.5, true) > blendSortScore(0.1, 0.5, true));
  // 커서 검증(0~1)을 벗어나지 않는다
  assert.ok(blendSortScore(1, 1, true) <= 1);
  assert.ok(blendSortScore(0, 0, true) >= 0);
  // 검색어가 없으면 기존 순서 그대로다
  assert.equal(blendSortScore(0.42, 0, false), 0.42);
});

test("결과 내 검색어는 60자까지 받고 잘라내지 않고 거절한다", () => {
  assert.deepEqual(validateSortQuery(undefined), { ok: true, value: null });
  assert.deepEqual(validateSortQuery("   "), { ok: true, value: null });
  assert.deepEqual(validateSortQuery(" 전세 "), { ok: true, value: "전세" });
  assert.equal(validateSortQuery(123).ok, false);
  assert.equal(validateSortQuery("가".repeat(MAX_SORT_QUERY_LEN)).ok, true);
  assert.equal(validateSortQuery("가".repeat(MAX_SORT_QUERY_LEN + 1)).ok, false);
});

test("결과 내 검색은 순서만 바꾸고 한 건도 숨기지 않는다", async () => {
  const plain = await demoMatch({});
  const sorted = await demoMatch({ sortQuery: "전세" });

  assert.equal(sorted.sortApplied, true);
  assert.equal(plain.sortApplied, false);
  // 건수는 어느 축에서도 달라지지 않는다 — 정렬은 후보 집합을 건드리지 않는다
  assert.equal(sorted.summary.total, plain.summary.total);
  assert.deepEqual(sorted.summary.byForm, plain.summary.byForm);
  assert.equal(sorted.intentHiddenCount, plain.intentHiddenCount);
  assert.equal(sorted.nearMisses.length, plain.nearMisses.length);

  const ids = (r) => new Set(r.pages.all.cards.map((c) => c.program.id));
  assert.deepEqual(
    [...ids(sorted)].sort((a, b) => a - b).slice(0, 5),
    [...ids(plain)].sort((a, b) => a - b).slice(0, 5),
  );
});

test("검색어가 걸린 공고가 맨 위로 올라온다", async () => {
  const sorted = await demoMatch({ sortQuery: "전세" });
  const cards = sorted.pages.all.cards;
  const top = cards[0];
  assert.ok(top.program.title.includes("전세"), top.program.title);
  assert.equal(top.keywordScore, 1);

  // 걸린 건이 하나도 안 걸린 건보다 앞이고, 점수는 내림차순으로 유지된다
  const firstMiss = cards.findIndex((c) => c.keywordScore === 0);
  if (firstMiss !== -1) {
    assert.ok(cards.slice(firstMiss).every((c) => c.keywordScore === 0));
  }
  for (let i = 1; i < cards.length; i += 1) {
    assert.ok(cards[i - 1].score >= cards[i].score);
  }
});

test("아무 데도 걸리지 않는 검색어는 원래 순서를 흐트러뜨리지 않는다", async () => {
  const plain = await demoMatch({});
  const nonsense = await demoMatch({ sortQuery: "존재하지않는낱말" });
  assert.equal(nonsense.sortApplied, true);
  assert.deepEqual(
    nonsense.pages.all.cards.map((c) => c.program.id),
    plain.pages.all.cards.map((c) => c.program.id),
  );
  assert.ok(nonsense.pages.all.cards.every((c) => c.keywordScore === 0));
});

test("낱말이 하나도 안 남는 검색어는 정렬하지 않았다고 알린다", async () => {
  const punctuation = await demoMatch({ sortQuery: "!!!" });
  const plain = await demoMatch({});
  assert.equal(punctuation.sortApplied, false);
  assert.deepEqual(
    punctuation.pages.all.cards.map((c) => c.program.id),
    plain.pages.all.cards.map((c) => c.program.id),
  );
});

test("정렬한 결과도 커서로 이어서 받을 수 있다", async () => {
  const first = await demoMatch({ sortQuery: "지원" });
  const cursor = first.pages.all.nextCursor;
  if (cursor === null) return; // 데모 데이터가 한 페이지에 다 들어가면 확인할 것이 없다
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  assert.ok(decoded.score >= 0 && decoded.score <= 1);

  const second = await demoMatch({ sortQuery: "지원", cursor: decoded });
  const firstIds = first.pages.all.cards.map((c) => c.program.id);
  const secondIds = second.pages.all.cards.map((c) => c.program.id);
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
  const lastOfFirst = first.pages.all.cards.at(-1);
  assert.ok(second.pages.all.cards.every((c) => c.score <= lastOfFirst.score));
});
