/**
 * 2026 기준중위소득 정적 데이터 검증 (SPEC §5 소득).
 *
 * 이 표가 한 자리라도 틀리면 소득 필터가 **체계적으로** 어긋난다 — 개별 공고의 파싱 오류와
 * 달리 전 사용자·전 공고에 동시에 영향을 주고, 화면에는 아무 증상이 없다.
 *
 * 기존 `income.test.mjs` 는 `medianIncomeAmount()` 가 파일 값을 그대로 돌려주는지만 봤다.
 * 그건 파일을 파일로 검증하는 것이라 값이 틀려도 통과한다. 여기서는 **파일 밖의 사실**과
 * 대조한다 — 2025년 고시 표와 2026년 고시가 발표한 인상률이다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const table = JSON.parse(
  await readFile(new URL("../data/median_income_2026.json", import.meta.url), "utf8"),
);

/**
 * 2025년 가구원별 기준중위소득 (보건복지부 고시). 2026년 값이 여기에 발표 인상률을
 * 적용한 결과와 맞는지 보는 것이 이 파일의 핵심 검증이다.
 */
const Y2025 = {
  1: 2_392_013,
  2: 3_932_658,
  3: 5_025_353,
  4: 6_097_773,
  5: 7_108_192,
  6: 8_064_805,
};

/** 2026년 고시가 발표한 대표 인상률 — 1인 가구와 4인 가구 두 값이 보도자료의 헤드라인이다 */
const ANNOUNCED_RATE = { 1: 0.0720, 4: 0.0651 };

const SIZES = [1, 2, 3, 4, 5, 6, 7];

test("표의 형태가 온전하다", () => {
  assert.equal(table.year, 2026);
  assert.equal(table.unit, "KRW/month");
  for (const n of SIZES) {
    const amount = table.amounts[String(n)];
    assert.equal(typeof amount, "number", `${n}인 가구 금액이 없다`);
    assert.ok(Number.isInteger(amount) && amount > 0, `${n}인 가구 금액이 양의 정수가 아니다`);
  }
  assert.ok(Number.isInteger(table.additional_member_amount));
});

test("가구원 수가 늘면 기준액도 반드시 늘어난다", () => {
  for (let n = 2; n <= 7; n++) {
    assert.ok(
      table.amounts[String(n)] > table.amounts[String(n - 1)],
      `${n}인 가구 기준액이 ${n - 1}인 가구보다 크지 않다`,
    );
  }
});

test("출처와 기준일자가 파일 안에 명시돼 있다", () => {
  // 값이 맞는지 사람이 확인하려면 어느 고시를 봐야 하는지가 파일에 있어야 한다
  assert.equal(table.source.issuer, "보건복지부");
  assert.match(table.source.notice_no, /제\d{4}-\d+호/);
  assert.match(table.source.url, /^https:\/\//);
  assert.match(table.source.effective_from, /^\d{4}-\d{2}-\d{2}$/);
});

test("1인·4인 가구 값이 2025년 표 × 발표 인상률과 정확히 일치한다", () => {
  // 고시 산정은 절사이므로 Math.floor 로 맞춘다.
  for (const [size, rate] of Object.entries(ANNOUNCED_RATE)) {
    const expected = Math.floor(Y2025[size] * (1 + rate));
    const actual = table.amounts[size];
    assert.ok(
      Math.abs(actual - expected) <= 1, // 원 단위 반올림 방식 차이만 허용
      `${size}인 가구: 2025년 ${Y2025[size]}원 × ${(rate * 100).toFixed(2)}% = ${expected}원 이어야 하는데 ${actual}원이다`,
    );
  }
});

test("가구원 수가 늘수록 인상률이 낮아진다 (고시의 형평성 조정 구조)", () => {
  // 2026년 고시는 1인 가구를 가장 크게 올리고 가구원이 늘수록 인상률을 낮춘다.
  // 이 단조성이 깨지면 어느 한 칸을 잘못 옮겨 적었을 가능성이 높다.
  const rates = [1, 2, 3, 4, 5, 6].map((n) => table.amounts[String(n)] / Y2025[n] - 1);
  for (let i = 1; i < rates.length; i++) {
    assert.ok(
      rates[i] < rates[i - 1],
      `${i + 1}인 가구 인상률(${(rates[i] * 100).toFixed(2)}%)이 ${i}인 가구(${(rates[i - 1] * 100).toFixed(2)}%)보다 낮지 않다`,
    );
  }
  // 발표된 범위 밖으로 벗어나면 표를 잘못 옮겨 적은 것이다
  assert.ok(rates[0] <= 0.0721 && rates[0] >= 0.0719, "1인 가구 인상률이 7.20%가 아니다");
  assert.ok(rates[5] > 0.05 && rates[5] < rates[0], "6인 가구 인상률이 이상하다");
});

test("8인 이상 가산액이 7인·6인 차액과 일치한다", () => {
  // medianIncomeAmount(n>7) = 7인 + (n-7) × 가산액 이므로 이 둘이 어긋나면
  // 8인 이상 가구의 기준액이 7인에서 갑자기 튄다.
  assert.equal(
    table.additional_member_amount,
    table.amounts["7"] - table.amounts["6"],
    "가산액이 7인 가구와 6인 가구의 차액과 다르다",
  );
});

/*
  ────────────────────────────────────────────────────────────────────────────
  미해결: 7인 가구 값이 고시의 산정식과 어긋난다.

  보건복지부 고시는 7인 이상 가구를 표로 주지 않고 산정식으로 정의한다 —
  "7인 가구 = 6인 가구 + (6인 가구 − 5인 가구)". 2025년 표는 이 식을 정확히 따른다
  (8,064,805 + 956,613 = 9,021,418).

  2026년 값에 같은 식을 적용하면:
      8,555,952 + (8,555,952 − 7,556,719) = 9,555,185원
  그런데 파일에는 9,515,150원이 들어 있다. **40,035원 차이**다.

  1~6인 값은 발표 인상률과 정확히 맞아떨어지므로(위 테스트) 그쪽은 신뢰할 수 있다.
  7인만 인상률이 5.47%로 튀는데, 1~6인의 7.20→6.09% 하강 곡선을 잇는 값은 5.9% 근처이고
  그것이 곧 산정식 결과다. 즉 **파일의 7인 값이 틀렸을 가능성이 높다.**

  다만 2026년 고시가 7인 가구를 직접 표로 공표했을 가능성을 배제할 수 없어 임의로 고치지
  않는다. 고시 원문(source.url)에서 7인 가구 항목을 눈으로 확인한 뒤 둘 중 하나를 하라:
    (a) 산정식이 맞다  → amounts["7"] = 9555185, additional_member_amount = 999233 로 고치고
                         income.test.mjs 의 7·8·10인 기대값도 함께 고친 뒤 이 skip 을 해제
    (b) 파일 값이 맞다  → 이 블록을 지우고 "고시가 7인을 직접 공표한다"는 주석을 남긴다

  영향 범위는 7인 이상 가구뿐이지만, 소득 필터는 조용히 틀리는 종류의 오류다.
  ────────────────────────────────────────────────────────────────────────────
*/
test(
  "7인 가구 값이 고시 산정식(6인 + 6인·5인 차액)과 일치한다",
  { skip: "고시 원문 대조 필요 — 위 주석 참조. 현재 40,035원 불일치" },
  () => {
    const step = table.amounts["6"] - table.amounts["5"];
    assert.equal(table.amounts["7"], table.amounts["6"] + step);
    assert.equal(table.additional_member_amount, step);
  },
);
