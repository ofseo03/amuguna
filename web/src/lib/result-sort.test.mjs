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
} from "./result-sort.ts";
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

test("정렬 축은 셋뿐이고 기본은 정확도순이다", () => {
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
