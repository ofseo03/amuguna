/**
 * 화면 고지 문구와 프로필 없는 접근 (SPEC §8, §9).
 *
 * 두 가지를 고정한다.
 * 1. 프로필 쿠키 없이 상세 URL 로 들어와도 공고 정보는 정상 노출된다 — 상세 페이지 URL
 *    공유가 설계 전제(§3.2, programs.id 유지)인데 제3자에게 에러나 빈 화면이 보이면
 *    그 전제가 무너진다.
 * 2. 금융소비자보호법 대응 — "추천·권유"로 읽히는 문구 대신 "비교·정보 제공"으로 쓰고,
 *    특정 상품 권유가 아님을 상시 노출 위치에 둔다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { FINANCIAL_PRODUCT_FORMS, FORMS, isFinancialProduct } from "./forms.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/* ------------------------------------------- 프로필 없는 상세 접근 */

test("프로필이 없어도 상세의 공고 정보는 그대로 렌더된다", async () => {
  const page = await read("../app/programs/[id]/page.tsx");

  // 프로필 유무로 갈리는 것은 자격 판정 영역뿐이어야 한다
  assert.match(page, /\{ev && \(/, "자격 판정 요약이 프로필 조건부가 아니다");
  assert.match(page, /\{checks && \(/, "체크리스트가 프로필 조건부가 아니다");

  // 프로필이 없으면 에러나 빈 화면이 아니라 CTA 를 보여준다
  assert.match(page, /\{!profile && \(/);
  assert.match(page, /href="\/onboarding"/);

  // 제목·금액·기한·절차·원문은 조건 없이 렌더된다 — notFound() 는 공고가 없을 때만이다
  assert.match(page, /if \(!program\) notFound\(\);/);
  const afterProfile = page.slice(page.indexOf("const profile = await readProfile()"));
  for (const marker of ["지원 금액과 기한", "신청 절차", "출처", "공고 내용"]) {
    assert.ok(afterProfile.includes(marker), `${marker} 섹션이 없다`);
  }
  // 이 섹션들이 profile 조건부 블록 안에 들어가면 안 된다
  assert.doesNotMatch(page, /profile && \([^)]*지원 금액과 기한/su);
});

test("상세 API 도 프로필 없이 200 을 돌려준다", async () => {
  const route = await read("../app/api/programs/[id]/route.ts");
  // 프로필이 없으면 checklist 만 null 이고 program 은 그대로 나간다
  assert.match(route, /checklist: profile \? checklist\(.*\) : null/);
  assert.match(route, /const ev = profile \? evaluate\(.*\) : null;/);
  assert.match(route, /eligible: ev \? \(ev\.violations > 0 \? false : review \? null : true\) : null/);
  assert.doesNotMatch(route, /eligibilityStatus/);
  // 프로필 없음을 401 로 막으면 공유된 URL 이 제3자에게 열리지 않는다
  assert.doesNotMatch(route, /no_profile/);
});

test("결과 탐색 상태는 브라우저 히스토리에 한 번만 보관한다", async () => {
  const results = await read("../app/results/page.tsx");
  assert.match(results, /history\.replaceState/);
  assert.match(results, /amugunaResult/);
  assert.doesNotMatch(results, /RESULT_STATE_STORAGE_KEY/);
});

/* ------------------------------------------------- 금소법 대응 문구 */

test("상시 고지에 자격 판정 한계와 권유 아님이 함께 들어 있다", async () => {
  const chrome = await read("../components/SiteChrome.tsx");
  assert.match(chrome, /최종 자격 판정은 소관 기관 확인이 필요합니다/);
  assert.match(chrome, /권유하지 않습니다/, "특정 상품 권유가 아니라는 문구가 없다");
  assert.match(chrome, /비교·안내/, "정보 제공 성격을 밝히는 문구가 없다");
  // 푸터는 전 화면에 깔리므로 여기에도 있어야 상시 노출이 성립한다
  const footer = chrome.slice(chrome.indexOf("export function SiteFooter"));
  assert.match(footer, /권유하지 않습니다/);
});

test("금융상품 분류에는 전용 고지가 붙는다", async () => {
  assert.deepEqual(FINANCIAL_PRODUCT_FORMS, ["loan", "product"]);
  assert.equal(isFinancialProduct("loan"), true);
  assert.equal(isFinancialProduct("product"), true);
  assert.equal(isFinancialProduct("subsidy"), false);
  assert.equal(isFinancialProduct("law"), false);
  // 분류가 늘어나도 판정 함수가 FORMS 안에서만 동작하는지 확인
  for (const form of FORMS) assert.equal(typeof isFinancialProduct(form), "boolean");

  const detail = await read("../app/programs/[id]/page.tsx");
  assert.match(detail, /isFinancialProduct\(program\.form\) && \(/);
  assert.match(detail, /<FinancialProductNotice form=\{program\.form\} \/>/);

  const results = await read("../app/results/page.tsx");
  assert.match(results, /isFinancialProduct\(tab\)/);
  assert.match(results, /<FinancialProductNotice form=\{tab\} \/>/);
});

test("전용 고지가 출처와 변동 가능성을 밝힌다", async () => {
  const chrome = await read("../components/SiteChrome.tsx");
  const notice = chrome.slice(chrome.indexOf("export function FinancialProductNotice"));
  assert.match(notice, /금융감독원/, "공시 출처가 없다");
  assert.match(notice, /개인 신용도에 따라/, "대출 조건 변동 가능성 안내가 없다");
  assert.match(notice, /가입 기간·조건에 따라/, "예금 조건 변동 가능성 안내가 없다");
  assert.match(notice, /권유하는 것이 아닙니다/);
});

test("사용자에게 보이는 문구에 '추천'이 남아 있지 않다", async () => {
  // 추천은 금소법상 권유로 읽힐 수 있다. 정보 제공·비교 표현으로 통일한다.
  // (공고 원문에서 온 데이터의 '추천서 발급' 같은 표현은 대상이 아니다 — 화면 문구만 본다)
  const screens = [
    "../app/page.tsx",
    "../app/results/page.tsx",
    "../app/programs/[id]/page.tsx",
    "../app/onboarding/page.tsx",
    "../components/SiteChrome.tsx",
    "../components/ProgramCard.tsx",
  ];
  for (const path of screens) {
    const code = await read(path);
    for (const [, line] of code.split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // 주석은 사용자에게 보이지 않는다
      assert.ok(
        !/추천(?!서)/.test(line),
        `${path} 의 화면 문구에 '추천'이 있다: ${line.trim()}`,
      );
    }
  }
});
