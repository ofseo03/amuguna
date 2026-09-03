import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checklist, dDay, evaluate, isOpen, nearMissMessage, needsEligibilityReview } from "./eligibility.ts";
import { deserializeProfile, serializeProfile } from "./session.ts";
import { medianIncomeAmount, medianIncomePercent } from "./shared-data.ts";
import { validateProfile } from "./validation.ts";

const profile = {
  age: 30,
  gender: null,
  occupation: "employee_office",
  sidoCode: "11",
  sigunguCode: "11620",
  incomeDecile: 3,
  medianIncomePercent: 80,
};

const rules = {
  age_min: null,
  age_max: null,
  gender: null,
  regions: null,
  occupations: null,
  income_decile_max: 4,
  median_income_percent_max: 100,
  extra_conditions: [],
  parse_method: "regex",
  confidence: 1,
};

test("2026 official median-income calculator covers fixed and 8+ households", () => {
  assert.equal(medianIncomeAmount(1), 2_564_238);
  assert.equal(medianIncomeAmount(7), 9_515_150);
  assert.equal(medianIncomeAmount(8), 10_474_348);
  assert.equal(medianIncomeAmount(10), 12_392_744);
  assert.equal(medianIncomePercent(1, 2_564_238), 100);
  assert.equal(medianIncomePercent(1, 256.4238 * 10_000), 100);
  assert.equal(medianIncomePercent(1, 2_564_239), 101);
});

test("income axes are validated and compared independently", () => {
  assert.equal(validateProfile(profile).ok, true);
  assert.equal(validateProfile({ ...profile, incomeDecile: null, medianIncomePercent: null }).ok, true);
  assert.equal(validateProfile({ ...profile, incomeDecile: 11 }).ok, false);
  assert.equal(validateProfile({ ...profile, medianIncomePercent: 10001 }).ok, false);

  assert.deepEqual(evaluate(rules, profile).violatedDimensions, []);
  assert.deepEqual(evaluate(rules, { ...profile, incomeDecile: 5 }).violatedDimensions, ["income"]);
  assert.deepEqual(
    evaluate(rules, { ...profile, medianIncomePercent: 101 }).violatedDimensions,
    ["income"],
  );
  const unknown = { ...profile, incomeDecile: null, medianIncomePercent: null };
  assert.deepEqual(evaluate(rules, unknown).unknownDimensions, ["income"]);
  assert.equal(checklist(rules, unknown).find(({ dimension }) => dimension === "income")?.unknown, true);
  const bothExceeded = { ...profile, incomeDecile: 5, medianIncomePercent: 101 };
  assert.match(nearMissMessage("income", rules, bothExceeded), /현재 5분위.*현재 약 101%/);
});

test("income migration preserves legacy evidence and an unambiguous RPC", async () => {
  const sql = await readFile(
    new URL("../../../db/migrations/0006_income_axes.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /parse_evidence = \(parse_evidence - 'income_decile_max'\)/);
  assert.match(sql, /중위소득[^']*미만/);
  assert.doesNotMatch(sql, /p_qvec\s+vector\(1024\)\s+DEFAULT/);
  assert.doesNotMatch(sql, /p_topk\s+int\s+DEFAULT/);
});


test("unknown occupation migration bypasses only the occupation mismatch", async () => {
  const sql = await readFile(
    new URL("../../../db/migrations/0014_unknown_occupation.sql", import.meta.url),
    "utf8",
  );
  assert.equal((sql.match(/p_occupation = 'other'/g) ?? []).length, 2);
  assert.match(sql, /p_occupation = ANY \(e\.occupations\)/);
});

test("an omitted gender passes without claiming that the condition matched", () => {
  const genderRules = { ...rules, gender: "F", income_decile_max: null, median_income_percent_max: null };
  const result = evaluate(genderRules, profile);
  assert.equal(result.violations, 0);
  assert.deepEqual(result.matchedDimensions, []);
  assert.deepEqual(result.unknownDimensions, ["gender"]);
  assert.equal(checklist(genderRules, profile).find(({ dimension }) => dimension === "gender")?.unknown, true);
  assert.equal(needsEligibilityReview(genderRules, result.unknownDimensions), true);
});

test("an unknown occupation remains a review candidate instead of a rejection", () => {
  const occupationRules = {
    ...rules,
    occupations: ["student"],
    income_decile_max: null,
    median_income_percent_max: null,
  };
  const unknownOccupation = { ...profile, occupation: "other" };
  const result = evaluate(occupationRules, unknownOccupation);
  assert.equal(result.violations, 0);
  assert.deepEqual(result.matchedDimensions, []);
  assert.deepEqual(result.unknownDimensions, ["occupation"]);
  assert.equal(
    checklist(occupationRules, unknownOccupation).find(({ dimension }) => dimension === "occupation")?.unknown,
    true,
  );
  assert.equal(needsEligibilityReview(occupationRules, result.unknownDimensions), true);
});

test("unstructured conditions prevent a confirmed eligibility label", () => {
  const result = evaluate(rules, profile);
  assert.equal(needsEligibilityReview({ ...rules, needs_review: true }, result.unknownDimensions), true);
  assert.equal(
    needsEligibilityReview({ ...rules, extra_conditions: [{ label: "가구", text: "다자녀" }] }, result.unknownDimensions),
    true,
  );
  assert.equal(needsEligibilityReview({ ...rules, needs_review: false }, result.unknownDimensions), false);
});

test("a date-only deadline remains open through its KST calendar day", () => {
  const program = { status: "active", ends_at: "2026-08-13", is_always_open: false };
  assert.equal(isOpen(program, new Date("2026-08-13T14:59:59Z")), true);
  assert.equal(dDay(program, new Date("2026-08-13T14:59:59Z")), 0);
  assert.equal(isOpen(program, new Date("2026-08-13T15:00:00Z")), false);
  assert.equal(dDay(program, new Date("2026-08-13T15:00:00Z")), -1);
});

test("signed profile cookies keep derived percent and accept legacy cookies", () => {
  assert.deepEqual(deserializeProfile(serializeProfile(profile)), profile);
  const legacy = { ...profile };
  delete legacy.medianIncomePercent;
  assert.equal(deserializeProfile(serializeProfile(legacy)).medianIncomePercent, null);
});
