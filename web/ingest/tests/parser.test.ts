import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeText } from "../dictionaries";
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
  ["기준 중위소득 60% 이하 가구", { median_income_percent_max: 60 }],
  ["기준 중위소득 150% 이하", { median_income_percent_max: 150 }],
  ["중위소득 100% 이하 가구", { median_income_percent_max: 100 }],
  ["기준 중위소득 48% 이하 가구", { median_income_percent_max: 48 }],
  ["소득 3분위 이하 가구", { income_decile_max: 3 }],
  ["차상위계층 또는 기초생활수급 가구", { income_decile_max: null }],
  ["기준 중위소득 180% 이하 가구원", { median_income_percent_max: 180 }],
  ["기준 중위소득 150% 미만 가구", { median_income_percent_max: 149 }],
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
    { age_min: 19, age_max: 34, median_income_percent_max: 150, regions: ["11"] },
  ],
  ["기초생활수급 가구의 만 65세 이상 어르신", { age_min: 65, income_decile_max: null }],
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

test("parser contract keeps normal and trap cases", () => {
  assert.equal(NORMAL_CASES.length, 31);
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

  const industrial = parseEligibility("산업재해로 치료 중인 산재근로자를 지원합니다");
  assert(industrial.extra_conditions.some(({ kind }) => kind === "industrial_accident"));
  assert.deepEqual(industrial.occupations?.sort(), ["employee_field", "employee_office"]);
});

test("age conjunction intersects while OR alternatives stay unfiltered", () => {
  const conjunction = parseEligibility("만 19세 이상 및 만 34세 이하");
  assert.deepEqual([conjunction.age_min, conjunction.age_max], [19, 34]);
  assert(!conjunction.extra_conditions.some(({ kind }) => kind === "age_alternatives"));

  const alternative = parseEligibility("만 19세 이하 또는 만 65세 이상");
  assert.deepEqual([alternative.age_min, alternative.age_max], [null, null]);
  assert(alternative.extra_conditions.some(({ kind }) => kind === "age_alternatives"));
  const synonym = parseEligibility("만 19세 이하 혹은 만 65세 이상");
  assert.deepEqual([synonym.age_min, synonym.age_max], [null, null]);

  const reversed = parseEligibility("만 65세 이상 19세 이하");
  assert.deepEqual([reversed.age_min, reversed.age_max], [null, null]);
});

test("live notation variants and invalid scalar values stay inside the schema", () => {
  for (const text of ["19세~34세", "만 19세~만 34세", "만 19세～34세"]) {
    assert.deepEqual([parseEligibility(text).age_min, parseEligibility(text).age_max], [19, 34], text);
  }
  assert.equal(parseEligibility("소득 1분위 이하").income_decile_max, 1);
  assert.equal(parseEligibility("소득 10분위 이하").income_decile_max, 10);
  assert.equal(parseEligibility("소득 0분위 이하").income_decile_max, null);
  assert.equal(parseEligibility("소득 11분위 이하").income_decile_max, null);
  assert.equal(parseEligibility("만 999세 이상").age_min, null);
  assert.equal(parseEligibility("기준 중위소득 1500% 이하").median_income_percent_max, null);
  assert.equal(parseEligibility("만 18세 이상 한부모가족 세대주").age_min, 18);
});

test("related-person, venue, and alternative-list text never becomes a hard filter", () => {
  const related = parseEligibility(
    "부모가 만 65세 이상이고 농업인이며 자녀가 서울특별시에 거주하고 소득 3분위 이하인 가구",
  );
  assert.deepEqual(
    [related.age_min, related.occupations, related.regions, related.income_decile_max],
    [null, null, null, null],
  );
  assert.equal(
    parseEligibility("부모가 만 65세 이상이지만 신청자는 소득 3분위 이하인 가구")
      .income_decile_max,
    3,
  );
  assert.equal(parseEligibility("행사 장소: 부산광역시 해운대구").regions, null);
  assert.deepEqual(parseEligibility("부산광역시 해운대구 소재 사업장").regions, ["26350"]);

  const alternatives = parseEligibility(
    "다음 중 어느 하나에 해당하는 사람\n- 만 70세 이상 농업인\n- 일반 가구",
  );
  assert.equal(alternatives.age_min, null);
  assert.equal(alternatives.occupations, null);
  assert(alternatives.extra_conditions.some(({ kind }) => kind === "age_alternatives"));
});

test("Finlife-style applicant wording keeps shared age and explicit gender only", () => {
  const inclusive = parseEligibility("개인(개인사업자 포함)");
  assert.equal(inclusive.occupations, null);
  assert.equal(parseEligibility("개인\n및 개인사업자").occupations, null);

  const applicant = parseEligibility(
    "토스뱅크 통장 또는 토스뱅크 서브 통장을 보유한 만 17세 이상 여성으로 실명의 개인 및 개인사업자",
  );
  assert.equal(applicant.age_min, 17);
  assert.equal(applicant.gender, "F");
  assert.equal(applicant.occupations, null);
  assert.equal(parseEligibility("여성 신청자에 한함").gender, "F");
  assert.equal(parseEligibility("사고로 조업이 곤란한 여성어업인에게 일부 지원").gender, null);
  assert.equal(parseEligibility("보건소 또는 의료기관의 확인을 받은 자").occupations, null);
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
  assert.deepEqual(parseEligibility("서울특별시 관악구 거주").regions, ["11620"]);
  assert.deepEqual(parseEligibility("서울특별시 거주").regions, ["11"]);
  assert.deepEqual(parseEligibility("강원특별자치도 횡성군 거주").regions, ["51730"]);
  assert.deepEqual(parseEligibility("충청남도 보령시 거주").regions, ["44180"]);
  assert.deepEqual(parseEligibility("경상남도 남해군 거주").regions, ["48840"]);
  assert.deepEqual(parseEligibility("경기도 수원시 거주").regions, ["41"]);
  assert.equal(normalizeText(" 가\u00a0  나\r\n\r\n\r\n다 "), "가 나\n\n다");
});

test("the full region contract stays valid and synced", () => {
  const source = readFileSync(new URL("../../../shared/regions.json", import.meta.url), "utf8");
  const copy = readFileSync(new URL("../../src/data/regions.json", import.meta.url), "utf8");
  assert.equal(copy, source);
  const data = JSON.parse(source) as {
    sido: Array<{ code: string }>;
    sigungu: Array<{ code: string; sido: string }>;
  };
  assert.equal(data.sido.length, 17);
  assert.equal(data.sigungu.length, 256);
  assert.equal(new Set(data.sigungu.map(({ code }) => code)).size, data.sigungu.length);
  const sido = new Set(data.sido.map(({ code }) => code));
  assert(data.sigungu.every(({ code, sido: parent }) => /^\d{5}$/u.test(code) && sido.has(parent)));
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

test("non-requirements and partial alternatives never become hard filters", () => {
  const excluded = parseEligibility(
    "만 18세 이상 미취업 장애인을 지원합니다. 사업자 등록을 한 사람은 참여 대상에서 제외합니다.",
  );
  assert.equal(excluded.age_min, 18);
  assert.deepEqual(excluded.occupations, ["jobseeker"]);
  assert(!excluded.extra_conditions.some(({ kind }) => kind === "business_history"));
  assert.equal(parseEligibility("만 18세 이상이되 사업자는 제외합니다.").age_min, 18);
  assert.equal(parseEligibility("만 18세 이상이며 여성은 우대합니다.").age_min, 18);
  assert.equal(parseEligibility("만 18세 이상인 자(여성 제외)").age_min, 18);
  assert.equal(parseEligibility("서울특별시 거주자는 제외합니다.").regions, null);
  assert.equal(parseEligibility("여성은 우대합니다.").gender, null);

  const exempted = parseEligibility(
    "등록 장애인이 신청합니다. 기초생활수급자는 운전면허 요건을 면제받습니다. 의사의 소견을 제출해야 합니다.",
  );
  assert.equal(exempted.income_decile_max, null);
  assert.equal(exempted.occupations, null);

  const farmer = parseEligibility(
    "일반 농업인 또는 기초생활수급자 등 저소득 농업인 단체를 지원합니다.",
  );
  assert.deepEqual(farmer.occupations, ["farmer_fisher"]);
  assert.equal(farmer.income_decile_max, null);

  assert.equal(
    parseEligibility("부모와 영유아 또는 어린이집 보육교직원이 신청할 수 있습니다.")
      .occupations,
    null,
  );

  const assistance = parseEligibility("차상위계층 또는 기초생활수급 가구");
  assert.equal(assistance.income_decile_max, null);
  assert.equal(assistance.median_income_percent_max, null);
  assert(assistance.extra_conditions.some(({ kind }) => kind === "public_assistance"));
  assert.equal(parseEligibility("생계급여 또는 의료급여 수급 가구").income_decile_max, null);
  assert.deepEqual(parseEligibility("농업인 또는 어업인").occupations, ["farmer_fisher"]);
  assert.deepEqual(parseEligibility("취업준비생 또는 개인사업자").occupations?.sort(), [
    "jobseeker",
    "self_employed",
  ]);
  assert.deepEqual(parseEligibility("의사 또는 간호사만 신청 가능합니다").occupations, [
    "medical",
  ]);

  assert.equal(parseEligibility("만 19세 이상 또는 장애인").age_min, null);
  assert.equal(parseEligibility("서울특별시 거주자 또는 장애인").regions, null);
  assert.deepEqual(
    parseEligibility("미취업 장애인을 지원합니다. 농업인 또는 일반 가구에 우대합니다.").occupations,
    ["jobseeker"],
  );
  assert.equal(
    parseEligibility("기준 중위소득 100% 이하인 농업인 또는 어업인").median_income_percent_max,
    100,
  );
  assert.deepEqual(
    parseEligibility("전라남도 순천시에 거주하는 농업인 또는 어업인").regions,
    ["46150"],
  );
  assert.equal(parseEligibility("만 19세 이상 청년 중 저소득층을 우대합니다.").age_min, 19);
  assert.equal(
    parseEligibility("기준 중위소득 100% 이하 가구 중 한부모 가구를 우선 지원합니다.")
      .median_income_percent_max,
    100,
  );
  assert.equal(
    parseEligibility("만 19세 이상 청년을 지원하며 저소득층을 우대합니다.").age_min,
    19,
  );
  assert.deepEqual(
    parseEligibility("서울특별시 거주자를 지원하며 장애인에게 가점을 부여합니다.").regions,
    ["11"],
  );
  assert.equal(
    parseEligibility("기준 중위소득 100% 이하 가구를 지원하며 한부모 가구를 우선 지원합니다.")
      .median_income_percent_max,
    100,
  );
  assert.equal(
    parseEligibility("기준 중위소득 100% 이하인 농업인 또는 소득 무관 어업인")
      .median_income_percent_max,
    null,
  );
  assert.equal(
    parseEligibility("만 19세 이상인 근로자 또는 연령 무관 자영업자").age_min,
    null,
  );
  assert.equal(
    parseEligibility("서울특별시에 거주하는 농업인 또는 지역 무관 어업인").regions,
    null,
  );
  assert.equal(
    parseEligibility("기준 중위소득 100% 이하인 농업인 또는 소득 제한 없는 어업인")
      .median_income_percent_max,
    null,
  );
  assert.equal(
    parseEligibility("만 19세 이상인 근로자 또는 연령 제한 없는 자영업자").age_min,
    null,
  );
  assert.equal(
    parseEligibility("서울특별시에 거주하는 농업인 또는 전국 어업인").regions,
    null,
  );
  assert.equal(
    parseEligibility("농업인을 지원하며 기초생활수급자를 우선 선정합니다.").income_decile_max,
    null,
  );
  assert.deepEqual(
    parseEligibility("미취업 장애인을 지원합니다. 농업인 또는 일반 가구에 추가 혜택을 제공합니다.").occupations,
    ["jobseeker"],
  );

  const dependentAlternative = parseEligibility(
    "만 12세 이하 아동 또는 만 6세 이하 자녀를 양육하는 가정",
  );
  assert(!dependentAlternative.extra_conditions.some(({ kind }) => kind === "age_alternatives"));
  assert.equal(
    dependentAlternative.extra_conditions.filter(({ kind }) => kind === "dependent_person").length,
    1,
  );
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
