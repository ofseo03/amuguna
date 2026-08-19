/**
 * 중복 측정기의 제목 정규화 (SPEC §3.3).
 *
 * 이 측정 결과가 "병합 로직을 넣을지 소스를 줄일지"를 정하는 근거다. 정규화가 조용히
 * no-op 이 되면 중복률이 실제보다 낮게 나오고, 그 숫자를 보고 잘못된 결정을 하게 된다.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  bigrams,
  jaccard,
  normalizeIssuer,
  normalizeTitle,
  prepare,
  similarity,
  stripBoilerplate,
} from "../../scripts/lib/title-similarity.mjs";

test("상투어 제거가 한글에서 실제로 동작한다", () => {
  // 회귀 방지: `\b(사업|공고)\b` 는 ASCII 단어 경계라 한글에서 절대 매칭되지 않는다.
  // 그 버전에서는 아래가 전부 입력 그대로 나왔다.
  assert.equal(normalizeTitle("청년월세 지원 사업"), "청년월세지원");
  assert.equal(normalizeTitle("소상공인 정책자금 공고"), "소상공인정책자금");
  assert.equal(normalizeTitle("창업지원사업"), "창업");
  assert.notEqual(normalizeTitle("청년월세 지원 사업"), "청년월세지원사업");
});

test("다른 단어의 일부인 상투어는 건드리지 않는다", () => {
  // "사업자등록"의 '사업'을 지우면 엉뚱한 제목이 서로 비슷해진다
  assert.equal(normalizeTitle("사업자등록 지원"), "사업자등록지원");
  assert.equal(stripBoilerplate("사업자등록"), "사업자등록");
  assert.equal(stripBoilerplate("사업"), "");
  // 긴 접미사를 먼저 본다 — "지원사업"이 "사업"보다 먼저 잡혀야 한다
  assert.equal(stripBoilerplate("창업지원사업"), "창업");
});

test("연도·회차·괄호는 걷어낸다", () => {
  assert.equal(normalizeTitle("2026년 청년월세 한시 특별지원"), "청년월세한시특별지원");
  assert.equal(normalizeTitle("청년월세 한시 특별지원(2차)"), "청년월세한시특별지원");
  assert.equal(normalizeTitle("[서울] 청년도약계좌"), "서울청년도약계좌");
});

test("표기가 다른 같은 사업은 높게, 다른 사업은 낮게 나온다", () => {
  const score = (a, b) => similarity(prepare({ title: a }), prepare({ title: b }));

  // 진짜 중복 — 지역 접두어·연도·회차·상투어만 다르다
  assert.ok(
    score("2026년 청년월세 한시 특별지원 사업", "[서울] 청년월세 한시 특별지원(2차) 공고") >= 0.8,
    "지역 접두어가 붙은 진짜 중복이 임계치 아래로 떨어진다",
  );
  assert.equal(score("청년 전월세보증금 대출 지원", "청년 전월세보증금 대출지원 사업"), 1);

  // 이름만 비슷한 다른 사업 — 기본 임계치 0.6 아래여야 한다
  assert.ok(score("기초연금", "장애인연금") < 0.6);
  assert.ok(score("소상공인 정책자금 융자", "청년 창업 지원금") < 0.6);
});

test("소관기관이 같으면 가산되지만 1을 넘지 않는다", () => {
  // 정규화가 '부' 접미사를 흡수해 같은 기관으로 본다
  assert.equal(normalizeIssuer("국토교통부"), normalizeIssuer("국토교통"));

  // 제목이 완전히 같으면 jaccard 가 이미 1 이라 가산 여부를 볼 수 없다.
  // 부분적으로만 겹치는 제목으로 가산 효과를 확인한다.
  const base = { title: "청년월세 한시 특별지원" };
  const other = { title: "청년월세 특별지원" };
  const sameIssuer = similarity(
    prepare({ ...base, issuer: "국토교통부" }),
    prepare({ ...other, issuer: "국토교통" }),
  );
  const differentIssuer = similarity(
    prepare({ ...base, issuer: "국토교통부" }),
    prepare({ ...other, issuer: "서울특별시" }),
  );
  assert.ok(sameIssuer > differentIssuer, "같은 기관인데 가산되지 않았다");
  assert.ok(Math.abs(sameIssuer - differentIssuer - 0.1) < 1e-9, "가산폭이 0.1 이 아니다");

  // 제목까지 같으면 가산 후에도 1 을 넘지 않는다
  const identical = similarity(
    prepare({ title: "청년월세 지원", issuer: "국토교통부" }),
    prepare({ title: "청년월세 지원", issuer: "국토교통" }),
  );
  assert.equal(identical, 1, "가산 후에도 1을 넘지 않아야 한다");
});

test("빈 제목과 한 글자 제목에서 터지지 않는다", () => {
  assert.equal(normalizeTitle(""), "");
  assert.equal(normalizeTitle(null), "");
  assert.equal(normalizeTitle(undefined), "");
  assert.equal(bigrams("").size, 0);
  assert.equal(bigrams("가").size, 1);
  assert.equal(jaccard(bigrams(""), bigrams("가")), 0);
  assert.equal(similarity(prepare({ title: "" }), prepare({ title: "" })), 0);
});
