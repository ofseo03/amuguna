import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_TIEBREAK,
  DEFAULT_RESULT_SORT,
  RECENCY_SPAN_DAYS,
  RECENCY_WEIGHT,
  RESULT_SORTS,
  isResultSort,
  recencyDate,
  recencyScore,
  resultSortScore,
  resultSortLabel,
  resultSortHint,
} from "./result-sort.ts";
import { combine } from "./scoring.ts";
import { validateResultSort } from "./validation.ts";
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
  id: 1,
  title: "청년 전세자금 대출",
  starts_at: null,
  fetched_at: "2026-08-08T03:14:00+09:00",
  ...over,
});

test("정렬 축은 셋뿐이고 기본은 질문에 따라 관련도순 또는 추천순이다", () => {
  assert.deepEqual([...RESULT_SORTS], ["relevance", "newest", "oldest"]);
  assert.equal(DEFAULT_RESULT_SORT, "relevance");
  assert.ok(isResultSort("newest"));
  assert.ok(!isResultSort("newest "));
  assert.ok(!isResultSort(null));
});

test("모르는 정렬 축은 거절하지 않고 기본값으로 되돌린다", () => {
  // 정렬은 후보를 좁히지 않으므로 400 으로 끊으면 보여줄 수 있는 결과 화면만 사라진다
  assert.equal(validateResultSort("oldest"), "oldest");
  assert.equal(validateResultSort(undefined), "relevance");
  assert.equal(validateResultSort("아무거나"), "relevance");
  assert.equal(validateResultSort(7), "relevance");
});

test("공고일은 접수 시작일, 없으면 수집일(KST)이다", () => {
  assert.equal(recencyDate(program({ starts_at: "2026-03-02" })), "2026-03-02");
  // 수집 시각은 KST 달력 날짜로 읽는다 — UTC 로 읽으면 자정 근처에서 하루가 밀린다
  assert.equal(recencyDate(program({ fetched_at: "2026-08-08T00:30:00+09:00" })), "2026-08-08");
  assert.equal(recencyDate(program({ fetched_at: "" })), null);
  assert.equal(recencyScore(program({ fetched_at: "" })), 0);
});

test("날짜가 늦을수록 최신순 점수가 크고, 오래된순은 그 반대다", () => {
  const older = program({ starts_at: "2020-01-01" });
  const newer = program({ starts_at: "2026-01-01" });
  assert.ok(resultSortScore(0.5, newer, "newest") > resultSortScore(0.5, older, "newest"));
  assert.ok(resultSortScore(0.5, older, "oldest") > resultSortScore(0.5, newer, "oldest"));
  // 커서 검증(0~1)을 벗어나지 않는다
  for (const sort of ["newest", "oldest"]) {
    for (const p of [older, newer, program({ starts_at: "1970-01-01" })]) {
      const score = resultSortScore(1, p, sort);
      assert.ok(score >= 0 && score <= 1, `${sort} ${score}`);
    }
  }
});

test("날짜가 §7.4 스코어보다 항상 먼저 순서를 정한다", () => {
  // 하루 차이가 만드는 간격이 §7.4 스코어 0 대 1 의 차이보다 커야 한다
  const dayGap = RECENCY_WEIGHT / RECENCY_SPAN_DAYS;
  assert.ok(dayGap > BASE_TIEBREAK * 1);

  const a = program({ starts_at: "2026-01-02" });
  const b = program({ starts_at: "2026-01-01" });
  assert.ok(resultSortScore(0, a, "newest") > resultSortScore(1, b, "newest"));
  // 같은 날짜일 때만 §7.4 스코어가 정한다
  assert.ok(resultSortScore(0.9, a, "newest") > resultSortScore(0.1, a, "newest"));
});

test("정확도순은 §7.4 스코어를 그대로 쓴다", () => {
  assert.equal(resultSortScore(0.42, program({ starts_at: "2026-01-01" }), "relevance"), 0.42);
});

test("정렬은 순서만 바꾸고 한 건도 숨기지 않는다", async () => {
  const plain = await demoMatch({});
  const newest = await demoMatch({ sort: "newest" });
  const oldest = await demoMatch({ sort: "oldest" });

  assert.equal(plain.sort, "relevance");
  assert.equal(newest.sort, "newest");

  for (const sorted of [newest, oldest]) {
    // 건수는 어느 축에서도 달라지지 않는다 — 정렬은 후보 집합을 건드리지 않는다
    assert.equal(sorted.summary.total, plain.summary.total);
    assert.deepEqual(sorted.summary.byForm, plain.summary.byForm);
    assert.equal(sorted.intentHiddenCount, plain.intentHiddenCount);
    // 근접탈락은 정렬 버튼을 따르지 않는다 — 언제나 §7.4 스코어 상위 5건이다 (§7.6)
    assert.deepEqual(
      sorted.nearMisses.map((n) => n.program.id),
      plain.nearMisses.map((n) => n.program.id),
    );
  }
});

test("최신순은 공고일 내림차순, 오래된순은 오름차순으로 줄을 세운다", async () => {
  const newest = await demoMatch({ sort: "newest" });
  const oldest = await demoMatch({ sort: "oldest" });

  const dates = (r) => r.pages.all.cards.map((c) => recencyDate(c.program));
  const newestDates = dates(newest);
  const oldestDates = dates(oldest);

  for (let i = 1; i < newestDates.length; i += 1) {
    assert.ok(newestDates[i - 1] >= newestDates[i], `${newestDates[i - 1]} >= ${newestDates[i]}`);
  }
  for (let i = 1; i < oldestDates.length; i += 1) {
    assert.ok(oldestDates[i - 1] <= oldestDates[i], `${oldestDates[i - 1]} <= ${oldestDates[i]}`);
  }
  // 두 축이 실제로 다른 줄을 세운다 (데모 데이터의 공고일이 흩어져 있어야 성립한다)
  assert.notDeepEqual(
    newest.pages.all.cards.map((c) => c.program.id),
    oldest.pages.all.cards.map((c) => c.program.id),
  );
  // 점수는 어느 축에서도 내림차순으로 유지된다 — keyset 커서가 여기에 기댄다
  for (const cards of [newest.pages.all.cards, oldest.pages.all.cards]) {
    for (let i = 1; i < cards.length; i += 1) assert.ok(cards[i - 1].score >= cards[i].score);
  }
});

test("정렬한 결과도 커서로 이어서 받을 수 있다", async () => {
  const first = await demoMatch({ sort: "newest" });
  const cursor = first.pages.all.nextCursor;
  if (cursor === null) return; // 데모 데이터가 한 페이지에 다 들어가면 확인할 것이 없다
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  assert.ok(decoded.score >= 0 && decoded.score <= 1);

  const second = await demoMatch({ sort: "newest", cursor: decoded });
  const firstIds = first.pages.all.cards.map((c) => c.program.id);
  const secondIds = second.pages.all.cards.map((c) => c.program.id);
  assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
  const lastOfFirst = first.pages.all.cards.at(-1);
  assert.ok(second.pages.all.cards.every((c) => c.score <= lastOfFirst.score));
});


test("질문이 없으면 유사도는 제외하고 네 항목에 각각 25%를 적용한다", () => {
  const zero = { similarity: 1, specificity: 0, regionProximity: 0, amountScale: 0, deadlineUrgency: 0 };
  assert.equal(combine(zero, false).total, 0);
  for (const key of ["specificity", "regionProximity", "amountScale", "deadlineUrgency"]) {
    assert.equal(combine({ ...zero, [key]: 1 }, false).total, 0.25);
  }
});

test("관련도순은 종합점수와 무관하게 음수까지 유사도 순서를 보존한다", () => {
  const low = resultSortScore(1, program(), "relevance", -0.8);
  const high = resultSortScore(0, program(), "relevance", -0.2);
  assert.ok(high > low);
  assert.ok(low >= 0 && high <= 1);
  assert.equal(resultSortScore(0.8, program(), "relevance"), 0.8);
  assert.equal(resultSortLabel("relevance", true), "관련도순");
  assert.equal(resultSortLabel("relevance", false), "추천순");
  assert.match(resultSortHint("relevance", true), /입력한 내용/);
  assert.equal(resultSortLabel("newest", true), "최신순");
});

test("자연어 질문은 유사도순, 공백 및 전체 보기는 네 항목 추천순이다", async () => {
  const related = await demoMatch({ query: "청년 주거 보증금 대출" });
  assert.equal(related.usesSimilarity, true);
  const cards = related.pages.all.cards;
  assert.ok(cards.length > 1);
  for (let i = 1; i < cards.length; i++) assert.ok(cards[i - 1].sim >= cards[i].sim);
  for (const card of cards) assert.equal(card.score, resultSortScore(0, card.program, "relevance", card.sim));
  for (const input of [{ query: "  " }, { query: "청년 주거 보증금 대출", ignoreIntent: true }]) {
    const result = await demoMatch(input);
    assert.equal(result.usesSimilarity, false);
    for (const c of result.pages.all.cards) {
      const b = c.breakdown;
      assert.equal(c.score, resultSortScore((b.specificity + b.regionProximity + b.amountScale + b.deadlineUrgency) / 4, c.program, "relevance"));
    }
  }
  const last = cards[0];
  const next = await demoMatch({ query: "청년 주거 보증금 대출", cursor: { score: last.score, id: last.program.id } });
  assert.deepEqual(next.pages.all.cards.map(c => c.program.id), cards.slice(1).map(c => c.program.id));
});

test("임베딩 API 실패 시 질문이 있어도 추천순으로 돌아간다", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  delete process.env.DATABASE_URL;
  delete process.env.MOCK_EMBEDDINGS;
  process.env.EMBEDDING_PROVIDER = "voyage";
  process.env.EMBEDDING_API_KEY = "test-only-key";
  globalThis.fetch = async () => { throw new Error("test embedding unavailable"); };
  try {
    const result = await runMatch({ profile: P1, query: "실패 검증 전용 질문", form: "all", cursor: null });
    assert.equal(result.degraded, true);
    assert.equal(result.usesSimilarity, false);
    assert.ok(result.pages.all.cards.length > 0);
    for (const c of result.pages.all.cards) {
      const b = c.breakdown;
      assert.equal(c.score, resultSortScore((b.specificity + b.regionProximity + b.amountScale + b.deadlineUrgency) / 4, c.program, "relevance"));
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["DATABASE_URL", "MOCK_EMBEDDINGS", "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
