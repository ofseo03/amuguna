import assert from "node:assert/strict";
import test from "node:test";

import { midrateToDecile, normalizeText } from "../dictionaries";
import { CollectedProgram, EligibilityRules, HASHED_FIELDS } from "../models";
import {
  computeConfidence,
  eligibilitySourceText,
  parseEligibility,
  parseProgram,
  resolveParseMethod,
} from "../parser";

type Expected = Partial<EligibilityRules>;

const NORMAL_CASES: Array<[string, Expected]> = [
  ["만 19세 이상 34세 이하 청년", { age_min: 19, age_max: 34 }],
  ["만 65세 이상 어르신", { age_min: 65 }],
  ["만 40세 미만인 자", { age_max: 39 }],
  ["만 19~39세 청년", { age_min: 19, age_max: 39 }],
  ["19세 이상 34세 이하", { age_min: 19, age_max: 34 }],
  ["만 18세 부터 신청 가능", { age_min: 18 }],
  ["만 34세까지 신청할 수 있습니다", { age_max: 34 }],
  ["만 60세 초과 가입자", { age_min: 61 }],
  ["만 19세 이상 39세 미만 청년", { age_min: 19, age_max: 38 }],
  ["만 15세 이상 69세 이하 구직자", { age_min: 15, age_max: 69, occupations: ["jobseeker"] }],
  ["기준 중위소득 60% 이하 가구", { income_decile_max: 3 }],
  ["기준 중위소득 150% 이하", { income_decile_max: 7 }],
  ["중위소득 100% 이하 가구", { income_decile_max: 5 }],
  ["기준 중위소득 48% 이하 가구", { income_decile_max: 2 }],
  ["소득 3분위 이하 가구", { income_decile_max: 3 }],
  ["차상위계층 또는 기초생활수급 가구", { income_decile_max: 2 }],
  ["기준 중위소득 180% 이하 가구원", { income_decile_max: 8 }],
  ["여성만 신청 가능합니다", { gender: "F" }],
  ["남성에 한정합니다", { gender: "M" }],
  ["여성 가구주에 한함", { gender: "F" }],
  ["서울특별시 관악구에 거주하는 자", { regions: ["11620"] }],
  ["부산광역시 해운대구 소재 사업장", { regions: ["26350"] }],
  ["전라남도 순천시 거주 농업인", { regions: ["46150"], occupations: ["farmer_fisher"] }],
  ["경기도에 주소를 둔 세대", { regions: ["41"] }],
  ["소상공인 및 자영업자", { occupations: ["self_employed"] }],
  ["대학생 및 대학원생", { occupations: ["student"] }],
  ["프리랜서 및 특수형태근로종사자", { occupations: ["freelancer"] }],
  [
    "만 19세 이상 34세 이하이며 기준 중위소득 150% 이하인 서울특별시 거주 청년",
    { age_min: 19, age_max: 34, income_decile_max: 7, regions: ["11"] },
  ],
  ["기초생활수급 가구의 만 65세 이상 어르신", { age_min: 65, income_decile_max: 2 }],
  ["부산광역시 해운대구에 사업장을 둔 소상공인", { regions: ["26350"], occupations: ["self_employed"] }],
];

const TRAP_CASES: Array<[string, Expected, string]> = [
  ["만 65세 이상 어르신을 모시는 가구", { age_min: null, age_max: null }, "부양 대상 나이"],
  ["만 12세 이하 아동을 양육하는 가정", { age_min: null, age_max: null }, "양육 대상 나이"],
  ["자녀가 만 6세 이하인 가구", { age_min: null, age_max: null }, "앞쪽 부양가족"],
  ["여성가족부 소관 아이돌봄 사업", { gender: null }, "기관명"],
  ["여성기업 확인서를 보유한 중소기업", { gender: null, occupations: null }, "기업 속성"],
  ["사업 개시 후 3년 이상 경과한 기업", { age_min: null, age_max: null }, "업력"],
  ["기준 중위소득 150% 초과 가구는 지원 대상에서 제외됩니다", { income_decile_max: null }, "초과 제외"],
  ["부산광역시 해운대구 소재 점포", { regions: ["26350"] }, "지명 안의 대구"],
  ["중구에 거주하는 자", { regions: null }, "동명 시군구"],
  ["공무원연금 수급자는 제외합니다", { occupations: null }, "제외 대상"],
];

function checkSubset(rules: EligibilityRules, expected: Expected, message: string): void {
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(rules[field as keyof EligibilityRules], value, `${field}: ${message}`);
  }
}

test("parser contract keeps 30 normal and 10 trap cases", () => {
  assert.equal(NORMAL_CASES.length, 30);
  assert.equal(TRAP_CASES.length, 10);
  for (const [sentence, expected] of NORMAL_CASES) {
    checkSubset(parseEligibility(sentence), expected, sentence);
  }
  for (const [sentence, expected, why] of TRAP_CASES) {
    checkSubset(parseEligibility(sentence), expected, `${sentence} (${why})`);
  }
});

test("dependent and unformalizable clauses remain in extra_conditions", () => {
  const dependent = parseEligibility("만 65세 이상 어르신을 모시는 가구");
  assert(dependent.extra_conditions.some(({ kind }) => kind === "dependent_person"));

  const extra = parseEligibility(
    "관내 6개월 이상 계속 거주하며 무주택 세대주이고 최근 1년간 유사 지원을 받지 않은 자",
  );
  const kinds = new Set(extra.extra_conditions.map(({ kind }) => kind));
  assert(["residency_period", "housing", "duplicate_support"].every((kind) => kinds.has(kind)));
  assert.equal(extra.age_min, null);
  assert.equal(extra.income_decile_max, null);

  const exception = parseEligibility("기준 중위소득 150% 초과 가구는 지원 대상에서 제외됩니다");
  assert.equal(exception.income_decile_max, null);
  assert(exception.extra_conditions.some(({ kind }) => kind === "income_exception"));
});

test("age conjunction intersects while OR alternatives stay unfiltered", () => {
  const conjunction = parseEligibility("만 19세 이상 및 만 34세 이하");
  assert.deepEqual([conjunction.age_min, conjunction.age_max], [19, 34]);
  assert(!conjunction.extra_conditions.some(({ kind }) => kind === "age_alternatives"));

  const alternative = parseEligibility("만 19세 이하 또는 만 65세 이상");
  assert.deepEqual([alternative.age_min, alternative.age_max], [null, null]);
  assert(alternative.extra_conditions.some(({ kind }) => kind === "age_alternatives"));

  const reversed = parseEligibility("만 65세 이상 19세 이하");
  assert.deepEqual([reversed.age_min, reversed.age_max], [null, null]);
});

test("evidence, parse method, and confidence preserve parser diagnostics", () => {
  const rules = parseEligibility("만 19세 이상 34세 이하 청년");
  const evidence = rules.parse_evidence.age_min as Record<string, unknown>;
  assert.equal(evidence.method, "regex");
  assert.match(String(evidence.text), /19/);
  assert.equal(rules.parse_method, "regex");
  assert.equal(parseEligibility("자세한 내용은 공고문을 참고하시기 바랍니다").confidence, 0.2);
  assert(
    parseEligibility("만 19세 이상 34세 이하이며 서울특별시 거주 소상공인").confidence >
      parseEligibility("만 19세 이상").confidence,
  );

  const mixed = new EligibilityRules({
    age_min: 19,
    income_decile_max: 5,
    parse_evidence: { age_min: { method: "regex" }, income_decile_max: { method: "llm" } },
  });
  assert.equal(resolveParseMethod(mixed.parse_evidence), "mixed");
  assert.equal(computeConfidence(mixed), 0.672);
});

test("shared dictionaries and Korean normalization keep the parser contract", () => {
  for (const [percent, decile] of [
    [30, 2], [50, 2], [60, 3], [75, 3], [100, 5],
    [120, 6], [150, 7], [180, 8], [200, 9], [300, 10],
  ] as Array<[number, number]>) {
    assert.equal(midrateToDecile(percent), decile);
  }
  assert.deepEqual(parseEligibility("서울특별시 관악구 거주").regions, ["11620"]);
  assert.deepEqual(parseEligibility("서울특별시 거주").regions, ["11"]);
  assert.equal(normalizeText(" 가\u00a0  나\r\n\r\n\r\n다 "), "가 나\n\n다");
});

test("occupation and gender blockers avoid false exclusions", () => {
  assert.equal(parseEligibility("실명의 개인 및 개인사업자").occupations, null);
  assert.deepEqual(parseEligibility("사업자등록증을 보유한 개인사업자").occupations, ["self_employed"]);
  assert.equal(parseEligibility("여성 소상공인 대상 특별자금").gender, "F");
  assert.equal(parseEligibility("여성 한부모 가구").gender, "F");
  assert.equal(parseEligibility("남성 근로자에 한함").gender, "M");
  assert.equal(parseEligibility("여성기업 확인서 보유 기업").gender, null);
  assert.equal(parseEligibility("여성가족부 공고").gender, null);

  const age = parseEligibility("만 65세 이상 어르신 중 소득인정액이 선정기준액 이하인 분");
  assert.equal(age.age_min, 65);
  assert.equal(age.occupations, null);
  assert.deepEqual(parseEligibility("노인 대상 일자리 연계 사업").occupations, ["retired"]);
});

test("CollectedProgram hashes stable fields and builds the embedding source", () => {
  assert.deepEqual(HASHED_FIELDS, [
    "title", "body_text", "form", "issuer", "issuer_level", "benefit_amount_text",
    "benefit_amount_min", "benefit_amount_max", "apply_url", "apply_method", "starts_at",
    "ends_at", "is_always_open", "eligibility_text",
  ]);
  const base = new CollectedProgram({
    external_id: "fake:1",
    source_key: "fake",
    source_url: "https://example.test/1",
    title: "  청년\t지원 ",
    body_text: "본문",
    eligibility_text: "만 19세 이상",
  });
  const volatile = new CollectedProgram({ ...base.toDict(), source_url: "https://example.test/2", raw_body: { views: 9 } });
  assert.equal(base.contentHash(), volatile.contentHash());
  assert.equal(base.contentHash(), "82648b39f34a915a4b8e10fb5e8c9484b3c1b3e0d5d5e03533d814b974aaccd3");
  assert.equal(base.embeddingSource(), "본문\n\n[자격요건]\n만 19세 이상");

  const embedded = new CollectedProgram({ ...base.toDict(), body_text: "본문\n만 19세 이상" });
  assert.equal(embedded.embeddingSource(), "본문\n만 19세 이상");
  assert.equal(eligibilitySourceText(base), "만 19세 이상");
  assert.equal(parseProgram(base).age_min, 19);
});

test("EligibilityRules toRow omits pipeline-only review signals", () => {
  const rules = new EligibilityRules({ age_min: 19, needs_review: true, review_reason: "llm_failed" });
  assert.equal(rules.blocksActivation, true);
  assert.equal("needs_review" in rules.toRow(), false);
  assert.equal("review_reason" in rules.toRow(), false);
  assert.deepEqual(rules.filledFields(), ["age_min"]);
  assert.deepEqual(parseEligibility("").filledFields(), []);
  assert.deepEqual(parseEligibility("").extra_conditions, []);
});
