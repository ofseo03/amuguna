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
      const titles = result.pages.all.cards.map((card) => card.program.title);
      for (const title of persona.expected) assert.ok(titles.includes(title), title);
    }

    const p3 = await runMatch({ ...cases[2], form: "all", cursor: null });
    assert.equal(p3.degraded, false);
    assert.ok(
      p3.pages.all.cards.slice(0, 5).every((card) => card.program.title !== "예·적금 금리 비교공시"),
    );
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
    assert.ok(withQuery.nearMisses.length > 0, "근접 탈락이 있어야 비교가 의미 있다");
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

/*
 * 탭 전환이 서버를 왕복하면 평범한 조작 몇 번으로 세션 rate limit(10회/분, §8)에 걸린다.
 * 커서 없는 응답 하나가 비어 있지 않은 모든 탭의 1페이지를 담아야 그 왕복이 사라진다.
 */
test("cursorless response carries the first page of every non-empty tab", async () => {
  await withDemoMode(async () => {
    const profile = { age: 28, gender: "F", occupation: "employee_office", sidoCode: "11", sigunguCode: "11620", incomeDecile: 3, medianIncomePercent: null };
    const result = await runMatch({ profile, query: null, form: "all", cursor: null });

    assert.ok(result.pages.all.cards.length > 0);
    assert.equal(result.pages.all.cards.length, Math.min(result.summary.total, result.pageSize));
    for (const [form, count] of Object.entries(result.summary.byForm)) {
      // 건수가 0인 탭은 담지 않는다 — 화면에서도 비활성이라 누를 수 없다.
      if (count === 0) {
        assert.equal(result.pages[form], undefined, form);
        continue;
      }
      assert.ok(result.pages[form], form);
      assert.equal(result.pages[form].cards.length, Math.min(count, result.pageSize));
      assert.ok(result.pages[form].cards.every((card) => card.program.form === form), form);
    }

    // 커서가 붙은 요청은 그 탭 하나만 채운다 (2페이지 이후는 눌린 탭에서만 필요하다).
    // 번들 데모는 한 페이지에 다 들어가므로 목록 중간을 가리키는 커서를 직접 만들어 확인한다.
    const cards = result.pages.all.cards;
    assert.ok(cards.length >= 3, "커서 경로를 볼 만큼은 나와야 한다");
    const from = cards[1];
    const next = await runMatch({
      profile,
      query: null,
      form: "all",
      cursor: validateCursor(encodeMatchCursor({ score: from.score, id: from.program.id })).value,
    });
    assert.deepEqual(Object.keys(next.pages), ["all"]);
    assert.deepEqual(
      next.pages.all.cards.map((c) => c.program.id),
      cards.slice(2).map((c) => c.program.id),
      "커서 다음 건부터 이어져야 한다",
    );
    // 건수 요약은 커서와 무관하게 전체 기준이다 — 탭 배지가 페이지마다 흔들리면 안 된다.
    assert.equal(next.summary.total, result.summary.total);
  });
});

/*
 * §5 — 자유입력이 결과를 깎았다면 몇 건이 빠졌는지 알리고 되돌릴 수 있어야 한다.
 * 대상인데 몰라서 못 받는 것을 없애자는 서비스가 문장 한 줄로 대상인 것을 숨기면 안 된다.
 */
test("free-text filtering is reported and reversible", async () => {
  await withDemoMode(async () => {
    const profile = { age: 41, gender: "M", occupation: "self_employed", sidoCode: "11", sigunguCode: "11110", incomeDecile: 5, medianIncomePercent: null };
    const query = "오늘 점심 뭐 먹지";

    const filtered = await runMatch({ profile, query, form: "all", cursor: null });
    const everything = await runMatch({ profile, query, form: "all", cursor: null, ignoreIntent: true });

    assert.equal(filtered.intentIgnored, false);
    assert.equal(everything.intentIgnored, true);
    assert.equal(everything.intentHiddenCount, 0, "전체를 보는 중에는 숨긴 것이 없다");
    assert.ok(everything.summary.total >= filtered.summary.total);
    assert.equal(
      filtered.intentHiddenCount,
      everything.summary.total - filtered.summary.total,
      "숨겼다고 알린 건수와 실제로 늘어난 건수가 같아야 한다",
    );

    // 자유입력이 없으면 되돌릴 것도 없다.
    const noQuery = await runMatch({ profile, query: null, form: "all", cursor: null });
    assert.equal(noQuery.intentHiddenCount, 0);
    assert.equal(noQuery.intentIgnored, false);
  });
});

/** 데모 백엔드(번들 22건) + mock 임베딩으로 돌린다. 환경변수는 반드시 되돌린다. */
async function withDemoMode(body) {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    MOCK_EMBEDDINGS: process.env.MOCK_EMBEDDINGS,
  };
  delete process.env.DATABASE_URL;
  process.env.EMBEDDING_PROVIDER = "mock";
  process.env.MOCK_EMBEDDINGS = "1";
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
