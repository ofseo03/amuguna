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
  RESULT_SORT_LABEL,
  deadlineScore,
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

test("정렬 축은 셋뿐이고 기본 이름은 항상 추천순이다", () => {
  assert.deepEqual([...RESULT_SORTS], ["relevance", "newest", "deadline"]);
  assert.equal(DEFAULT_RESULT_SORT, "relevance");
  assert.ok(isResultSort("newest"));
  assert.ok(!isResultSort("newest "));
  assert.ok(!isResultSort(null));
});

test("모르는 정렬 축은 거절하지 않고 기본값으로 되돌린다", () => {
  // 정렬은 후보를 좁히지 않으므로 400 으로 끊으면 보여줄 수 있는 결과 화면만 사라진다
  assert.equal(validateResultSort("deadline"), "deadline");
  assert.equal(validateResultSort("oldest"), "relevance");
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

test("날짜가 늦을수록 최신순 점수가 크다", () => {
  const older = program({ starts_at: "2020-01-01" });
  const newer = program({ starts_at: "2026-01-01" });
  assert.ok(resultSortScore(0.5, newer, "newest") > resultSortScore(0.5, older, "newest"));
  // 커서 검증(0~1)을 벗어나지 않는다
  for (const sort of ["newest", "deadline"]) {
    for (const p of [older, newer, program({ starts_at: "1970-01-01" })]) {
      const score = resultSortScore(1, p, sort);
      assert.ok(score >= 0 && score <= 1, `${sort} ${score}`);
    }
  }
});

test("날짜가 추천 점수보다 항상 먼저 순서를 정한다", () => {
  // 하루 차이가 만드는 간격이 추천 점수 0 대 1 의 차이보다 커야 한다
  const dayGap = RECENCY_WEIGHT / RECENCY_SPAN_DAYS;
  assert.ok(dayGap > BASE_TIEBREAK * 1);

  const a = program({ starts_at: "2026-01-02" });
  const b = program({ starts_at: "2026-01-01" });
  assert.ok(resultSortScore(0, a, "newest") > resultSortScore(1, b, "newest"));
  // 같은 날짜일 때만 추천 점수가 정한다
  assert.ok(resultSortScore(0.9, a, "newest") > resultSortScore(0.1, a, "newest"));
});

test("질문 없는 추천순은 추천 점수를 그대로 쓴다", () => {
  assert.equal(resultSortScore(0.42, program({ starts_at: "2026-01-01" }), "relevance"), 0.42);
});

test("정렬은 순서만 바꾸고 한 건도 숨기지 않는다", async () => {
  const plain = await demoMatch({});
  const newest = await demoMatch({ sort: "newest" });
  const deadline = await demoMatch({ sort: "deadline" });

  assert.equal(plain.sort, "relevance");
  assert.equal(newest.sort, "newest");

  for (const sorted of [newest, deadline]) {
    // 건수는 어느 축에서도 달라지지 않는다 — 정렬은 후보 집합을 건드리지 않는다
    assert.equal(sorted.summary.total, plain.summary.total);
    assert.deepEqual(sorted.summary.byForm, plain.summary.byForm);
    assert.equal(sorted.intentHiddenCount, plain.intentHiddenCount);
    // 근접탈락은 정렬 버튼을 따르지 않는다 — 언제나 추천 점수 상위 5건이다 (§7.6)
    assert.deepEqual(
      sorted.nearMisses.map((n) => n.program.id),
      plain.nearMisses.map((n) => n.program.id),
    );
  }
});

test("최신순은 시작일 내림차순, 마감 임박순은 유효한 마감일 오름차순이다", async () => {
  for (const query of [null, "청년 주거 보증금 대출"]) {
    const newest = await demoMatch({ sort: "newest", query });
    const deadline = await demoMatch({ sort: "deadline", query });
    const dates = newest.pages.all.cards.map(c => recencyDate(c.program));
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i]);
    const due = deadline.pages.all.cards.map(c => c.program.is_always_open || !c.program.ends_at ? "9999-12-31" : c.program.ends_at);
    for (let i = 1; i < due.length; i++) assert.ok(due[i - 1] <= due[i]);
    assert.equal(newest.summary.total, deadline.summary.total);
    const cards = deadline.pages.all.cards;
    assert.ok(cards.length > 1);
    const first = cards[0];
    const next = await demoMatch({ sort: "deadline", query, cursor: { score: first.score, id: first.program.id } });
    assert.deepEqual(next.pages.all.cards.map(c => c.program.id), cards.slice(1).map(c => c.program.id));
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
  assert.equal(RESULT_SORT_LABEL.relevance, "추천순");
  assert.match(resultSortHint("relevance", true), /입력한 내용/);
  assert.equal(RESULT_SORT_LABEL.newest, "최신순");
  assert.equal(RESULT_SORT_LABEL.deadline, "마감 임박순");
  assert.match(resultSortHint("relevance", false), /25%/);
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


test("마감 임박순은 오늘·내일·먼 미래 뒤에 상시·미정을 둔다", () => {
  const today = program({ ends_at: "2026-09-05" });
  const tomorrow = program({ ends_at: "2026-09-06" });
  const distant = program({ ends_at: "2099-12-31" });
  const farEarlier = program({ ends_at: "2099-01-01" });
  assert.ok(resultSortScore(0, farEarlier, "deadline") > resultSortScore(1, distant, "deadline"));
  const latest = program({ ends_at: "9999-12-31" });
  assert.ok(resultSortScore(0, distant, "deadline") > resultSortScore(1, latest, "deadline"));
  const always = program({ ends_at: "2026-09-04", is_always_open: true });
  const unknown = program({ ends_at: null });
  assert.ok(resultSortScore(0, today, "deadline") > resultSortScore(1, tomorrow, "deadline"));
  assert.ok(resultSortScore(0, tomorrow, "deadline") > resultSortScore(1, distant, "deadline"));
  for (const p of [always, unknown]) {
    assert.equal(deadlineScore(p), 0);
    assert.ok(resultSortScore(0, latest, "deadline") > resultSortScore(1, p, "deadline"));
  }
});

test("날짜가 같으면 질문 유무에 따른 추천 기준으로 순위를 정한다", () => {
  const same = program({ starts_at: "2026-09-05", ends_at: "2026-09-10" });
  for (const sort of ["newest", "deadline"]) {
    // 종합 점수가 반대여도 질문이 있으면 유사도가 높은 쪽이 먼저다.
    assert.ok(resultSortScore(0, same, sort, 0.9) > resultSortScore(1, same, sort, 0.2));
    assert.ok(resultSortScore(1, same, sort) > resultSortScore(0, same, sort));
  }
  const later = program({ starts_at: "2026-09-06", ends_at: "2026-09-11" });
  assert.ok(resultSortScore(0, later, "newest", -1) > resultSortScore(1, same, "newest", 1));
  assert.ok(resultSortScore(0, same, "deadline", -1) > resultSortScore(1, later, "deadline", 1));
});
