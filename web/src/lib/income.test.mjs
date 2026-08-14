import assert from "node:assert/strict";
import test from "node:test";

import { checklist, evaluate } from "./eligibility.ts";
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
});

test("signed profile cookies keep derived percent and accept legacy cookies", () => {
  assert.deepEqual(deserializeProfile(serializeProfile(profile)), profile);
  const legacy = { ...profile };
  delete legacy.medianIncomePercent;
  assert.equal(deserializeProfile(serializeProfile(legacy)).medianIncomePercent, null);
});
