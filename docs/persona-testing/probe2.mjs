import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:3100";
const OCC = { student:"학생", employee_office:"사무직·전문직", employee_field:"현장·생산·서비스직",
  self_employed:"자영업·소상공인", farmer_fisher:"농림어업인", freelancer:"프리랜서·특수고용",
  jobseeker:"구직자·무직", homemaker:"주부", public_servant:"공무원·군인", medical:"보건·의료",
  education:"교육", retired:"은퇴·연금생활" };
const log = {};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function onboard(page, p) {
  await page.goto(`${BASE}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.fill("#age", String(p.age));
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText(p.gender === "M" ? "남성" : "여성", { exact: true }).click();
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText(OCC[p.occupation], { exact: true }).click();
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.selectOption("#sido", { label: p.sido });
  await page.selectOption("#sigungu", { label: p.sigungu });
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText(p.decile ? `${p.decile}분위` : "소득분위를 모릅니다", { exact: true }).click();
  if (p.household) { const n = page.locator('input[type="number"]'); await n.nth(0).fill(String(p.household)); await n.nth(1).fill(String(p.income)); }
  await page.getByRole("button", { name: "다음 →" }).click();
  if (p.query) { await page.fill("#query", p.query); await page.getByRole("button", { name: "결과 보기" }).click(); }
  else await page.getByRole("button", { name: "건너뛰기" }).click();
  await page.waitForURL("**/results"); await page.waitForSelector("h1"); await page.waitForTimeout(600);
}
const GRANNY = { age: 84, gender: "F", occupation: "retired", sido: "전라남도", sigungu: "순천시", decile: 1, household: 1, income: 38, query: "" };
const TEEN = { age: 15, gender: "F", occupation: "student", sido: "경기도", sigungu: "수원시 장안구", decile: null, household: 4, income: 280, query: "교복이랑 급식비 도움 받고 싶어요" };

/* G. 근접탈락 문구 전문 (고령 / 청소년) */
for (const [k, p] of [["granny", GRANNY], ["teen", TEEN]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await onboard(page, p);
  log[`G_nearmiss_${k}`] = await page.locator("section[aria-labelledby='nearmiss-heading'] > ul > li").evaluateAll(
    (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  // 법령 카드 상세 열어보기
  const law = page.locator("section[aria-label='매칭 결과'] > ul > li h3 a", { hasText: "시행령" });
  if (await law.count()) {
    await law.first().click();
    await page.waitForURL("**/programs/**");
    log[`G_lawDetail_${k}`] = {
      verdict: await page.locator("div.border-2 p").first().innerText().catch(() => null),
      hasApplyBtn: await page.getByRole("link", { name: /신청 페이지로 이동/ }).count(),
      text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 900),
    };
  }
  await ctx.close();
}

/* H. 세션 한도까지 상세 왕복 반복 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const api = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) api.push(`${r.status()} ${r.url().split("/api/")[1]}`); });
  await onboard(page, { ...GRANNY, query: "" });
  const trace = [];
  for (let i = 0; i < 14; i++) {
    const links = page.locator("section[aria-label='매칭 결과'] > ul > li h3 a");
    const n = await links.count();
    if (n === 0) break;
    await links.nth(i % n).click();
    await page.waitForURL("**/programs/**").catch(() => {});
    await page.goBack();
    await page.waitForURL("**/results*").catch(() => {});
    await page.waitForTimeout(450);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const blocked = /잠시 뒤에 다시|요청이 많아|다시 시도/.test(body);
    trace.push({ round: i + 1, calls: api.length, blocked });
    if (blocked) { log.H_blockedBody = body.slice(0, 500); log.H_cardsStillVisible = await page.locator("section[aria-label='매칭 결과'] > ul > li").count(); break; }
  }
  log.H_roundTrips = { trace, api };
  await ctx.close();
}

/* I. 5단계 화면 세부 — 계산기 위치·링크 크기·분위 버튼 라벨 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.fill("#age", "70"); await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText("여성", { exact: true }).click(); await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText("은퇴·연금생활", { exact: true }).click(); await page.getByRole("button", { name: "다음 →" }).click();
  await page.selectOption("#sido", { label: "서울특별시" }); await page.selectOption("#sigungu", { label: "중랑구" });
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.waitForTimeout(300);
  log.I_step5 = {
    pageHeight: await page.evaluate(() => document.body.scrollHeight),
    viewport: 844,
    decileLabels: await page.locator("fieldset").first().locator("label").allInnerTexts().then((a) => a.map((s) => s.replace(/\s+/g, " ").trim())),
    calcTop: (await page.locator("legend", { hasText: "기준중위소득 계산" }).boundingBox())?.y ?? null,
    nextBtnDisabled: await page.getByRole("button", { name: "다음 →" }).isDisabled(),
    gosiLink: await page.getByRole("link", { name: "보건복지부 고시 확인" }).boundingBox(),
  };
  // 계산기 한쪽만 채우면?
  await page.getByText("소득분위를 모릅니다", { exact: true }).click();
  await page.locator('input[type="number"]').nth(0).fill("2");
  await page.waitForTimeout(250);
  log.I_halfFilled = {
    nextDisabled: await page.getByRole("button", { name: "다음 →" }).isDisabled(),
    warning: await page.locator("p[role='alert']").allInnerTexts().catch(() => []),
    warnVisibleInViewport: await page.locator("p[role='alert']").first().isVisible().catch(() => false),
  };
  // 오타 상한 검증
  await page.locator('input[type="number"]').nth(1).fill("999999");
  await page.waitForTimeout(250);
  log.I_typo = await page.locator("p[aria-live='polite']").first().innerText().catch(() => null);
  await ctx.close();
}

/* J. 5세 아동 / 0세 입력이 가능한가 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.fill("#age", "5");
  log.J_child = { nextEnabled: !(await page.getByRole("button", { name: "다음 →" }).isDisabled()),
    warning: await page.locator("p[role='alert']").allInnerTexts().catch(() => []),
    helpText: await page.locator("#age-help").innerText() };
  await ctx.close();
}
await browser.close();
fs.writeFileSync(new URL("./probes2.json", import.meta.url), JSON.stringify(log, null, 1));
console.log("done");
