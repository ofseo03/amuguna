/* 1번(뒤로가기 재검색·스크롤)과 3번(근접탈락 나이 상한) 수정 검증 */
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
  await page.waitForURL("**/results"); await page.waitForSelector("h1"); await page.waitForTimeout(700);
}
const GRANNY = { age: 84, gender: "F", occupation: "retired", sido: "전라남도", sigungu: "순천시", decile: 1, household: 1, income: 38, query: "" };
const TEEN = { age: 15, gender: "F", occupation: "student", sido: "경기도", sigungu: "수원시 장안구", decile: null, household: 4, income: 280, query: "교복이랑 급식비 도움 받고 싶어요" };
const YOUTH = { age: 26, gender: "M", occupation: "employee_office", sido: "서울특별시", sigungu: "관악구", decile: 6, household: 1, income: 260, query: "보증금 올려달래서 대출 알아봐요" };

/* A. 상세 왕복 14번 — 요청 수와 429 여부, 스크롤 복원 */
for (const [k, p] of [["granny", GRANNY], ["youth", YOUTH]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const api = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) api.push(`${r.status()} ${r.url().split("/api/")[1]}`); });
  await onboard(page, p);
  const afterOnboard = api.length;
  const trace = [];
  for (let i = 0; i < 14; i++) {
    const links = page.locator("section[aria-label='매칭 결과'] > ul > li h3 a");
    const n = await links.count();
    if (n === 0) break;
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(300);          // 스크롤 저장 throttle(200ms) 통과
    await links.nth(i % n).click();
    await page.waitForURL("**/programs/**");
    await page.goBack();
    await page.waitForURL("**/results*");
    await page.waitForTimeout(500);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    trace.push({
      round: i + 1,
      calls: api.length,
      cards: await page.locator("section[aria-label='매칭 결과'] > ul > li").count(),
      scrollY: await page.evaluate(() => Math.round(window.scrollY)),
      blocked: /잠시 뒤에 다시|요청이 많아/.test(body),
    });
  }
  log[`A_${k}`] = { afterOnboard, totalCalls: api.length, api, trace };
  await ctx.close();
}

/* B. 되살린 뒤에도 탭·정렬·페이지가 정상 동작하는가 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const api = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) api.push(`${r.status()} ${r.url().split("/api/")[1]}`); });
  await onboard(page, GRANNY);
  // 대출 탭으로 옮기고 카드 → 뒤로
  await page.locator("nav[aria-label='분류별 좁혀보기'] button", { hasText: "대출" }).click();
  await page.waitForTimeout(400);
  const beforeCalls = api.length;
  await page.locator("section[aria-label='매칭 결과'] > ul > li h3 a").first().click();
  await page.waitForURL("**/programs/**");
  await page.goBack();
  await page.waitForURL("**/results*");
  await page.waitForTimeout(600);
  log.B_tabRestore = {
    url: page.url(),
    activeTab: await page.locator("nav[aria-label='분류별 좁혀보기'] button[aria-current='true'], nav[aria-label='분류별 좁혀보기'] button").allInnerTexts().then(a=>a.map(x=>x.replace(/\s+/g," "))),
    cards: await page.locator("section[aria-label='매칭 결과'] > ul > li").count(),
    callsForBack: api.length - beforeCalls,
  };
  // 정렬 축을 바꾸면 새로 받아야 한다
  await page.getByRole("button", { name: "최신순" }).click();
  await page.waitForTimeout(600);
  log.B_sortAfterRestore = { calls: api.length - beforeCalls, sortNotice: await page.locator("p[role='status']").allInnerTexts().then(a=>a.map(x=>x.replace(/\s+/g," ")).filter(x=>x.includes("보고 있습니다"))) };
  await ctx.close();
}

/* C. 조건을 다시 넣으면 옛 스냅샷을 쓰지 않는가 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await onboard(page, GRANNY);
  const before = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ");
  await onboard(page, YOUTH);
  const after = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ");
  log.C_profileChange = { before, after, stale: before === after };
  await ctx.close();
}

/* D. 근접탈락 문구 — 고령 / 청소년 */
for (const [k, p] of [["granny", GRANNY], ["teen", TEEN]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await onboard(page, p);
  log[`D_nearmiss_${k}`] = await page.locator("section[aria-labelledby='nearmiss-heading'] > ul > li").evaluateAll(
    (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(new URL("./verify.json", import.meta.url), JSON.stringify(log, null, 1));
console.log("done");
