/* 페르소나 실사용 중 반복해서 걸린 지점을 개별로 재현·계측 */
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
  await page.getByRole("button", { name: "다음 →" }).click();
  if (p.query) { await page.fill("#query", p.query); await page.getByRole("button", { name: "결과 보기" }).click(); }
  else await page.getByRole("button", { name: "건너뛰기" }).click();
  await page.waitForURL("**/results");
  await page.waitForSelector("h1");
  await page.waitForTimeout(600);
}

const P = { age: 67, gender: "M", occupation: "retired", sido: "서울특별시", sigungu: "은평구", decile: 3, query: "연금 외에 받을 수 있는 지원" };

/* ---- A. 상세 왕복이 세션 한도를 얼마나 먹는가 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const api = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) api.push(`${r.status()} ${r.url().split("/api/")[1].split("?")[0]}`); });
  await onboard(page, P);
  const trace = [{ step: "온보딩+결과 진입", calls: api.length }];
  for (let i = 0; i < 5; i++) {
    const links = page.locator("section[aria-label='매칭 결과'] > ul > li h3 a");
    const n = await links.count();
    if (i >= n) break;
    await links.nth(i).click();
    await page.waitForURL("**/programs/**");
    await page.goBack();
    await page.waitForURL("**/results*");
    await page.waitForSelector("h1").catch(() => {});
    await page.waitForTimeout(700);
    const body = await page.locator("body").innerText();
    trace.push({ step: `카드 ${i + 1}번 열고 뒤로`, calls: api.length, blocked: /잠시 뒤에 다시|요청이 많아/.test(body) });
    if (/잠시 뒤에 다시|요청이 많아/.test(body)) { log.A_blockedBody = body.replace(/\s+/g, " ").slice(0, 400); break; }
  }
  log.A_detailRoundTrip = { trace, api };
  await ctx.close();
}

/* ---- B. 정렬 버튼 3개 + 탭 전환이 요청을 얼마나 쓰는가 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const api = [];
  page.on("response", (r) => { if (r.url().includes("/api/")) api.push(`${r.status()} ${r.url().split("/api/")[1]}`); });
  await onboard(page, P);
  const base = api.length;
  for (const s of ["최신순", "오래된순", "정확도순"]) {
    await page.getByRole("button", { name: s }).click(); await page.waitForTimeout(500);
  }
  const afterSort = api.length;
  const tabs = await page.locator("nav[aria-label='분류별 좁혀보기'] button:not([disabled])").count();
  for (let i = 0; i < tabs; i++) {
    await page.locator("nav[aria-label='분류별 좁혀보기'] button:not([disabled])").nth(i).click();
    await page.waitForTimeout(300);
  }
  log.B_sortTabs = { afterOnboard: base, afterSort3: afterSort, afterAllTabs: api.length, api };
  await ctx.close();
}

/* ---- C. 조건 수정 프리필 / 브라우저 뒤로가기 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await onboard(page, P);
  await page.getByRole("link", { name: /조건 다시 입력하기|조건 수정/ }).first().click();
  await page.waitForURL("**/onboarding");
  await page.waitForTimeout(400);
  log.C_prefill = {
    stepLabel: await page.locator("p.text-brand").first().innerText().catch(() => null),
    ageValue: await page.inputValue("#age").catch(() => null),
  };
  // 단계 진행 후 브라우저 뒤로가기
  await page.fill("#age", "67");
  await page.getByRole("button", { name: "다음 →" }).click();
  await page.getByText("남성", { exact: true }).click();
  await page.getByRole("button", { name: "다음 →" }).click();
  const urlAt3 = page.url();
  await page.goBack();
  await page.waitForTimeout(600);
  log.C_backFromStep3 = { urlAt3, urlAfterBack: page.url(), heading: await page.locator("h1").first().innerText().catch(() => null) };
  await ctx.close();
}

/* ---- D. 큰 글씨 + 고령 페르소나 화면 ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const btns = await page.locator("header button, header input").count();
  // 글자 크기 최대로
  const slider = page.locator("input[type='range']").first();
  const hasSlider = await slider.count();
  if (hasSlider) { await slider.fill(await slider.getAttribute("max") ?? "22"); }
  else log.D_toggleShape = await page.locator("header").innerText();
  await onboard(page, { ...P, age: 84, gender: "F", occupation: "retired", sido: "전라남도", sigungu: "순천시", decile: 1, query: "" });
  log.D_bigFont = {
    headerControls: btns,
    rootFontSize: await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    hScroll: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    total: (await page.locator("h1").first().innerText()).replace(/\s+/g, " "),
  };
  // 터치 타깃 크기 점검
  log.D_smallTargets = await page.locator("a, button").evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.t && x.h > 0 && (x.h < 24 || x.w < 24)));
  await ctx.close();
}

/* ---- E. 키보드만으로 온보딩 (Tab/Enter) ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/onboarding`, { waitUntil: "domcontentloaded" });
  const seq = [];
  await page.keyboard.type("67");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  seq.push({ after: "1단계 Enter", h1: await page.locator("h1").innerText(), focus: await page.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("name") ?? "")) });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    seq.push({ tab: i + 1, focus: await page.evaluate(() => { const a = document.activeElement; return (a?.tagName ?? "") + ":" + ((a?.innerText || a?.getAttribute("name") || a?.id || "").slice(0, 20)); }) });
  }
  log.E_keyboard = seq;
  await ctx.close();
}

/* ---- F. 미성년자 개인정보 안내 문구 존재 여부 ---- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/privacy`, { waitUntil: "domcontentloaded" });
  const t = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log.F_privacy = { hasMinor: /만 ?14|미성년|법정대리인|보호자/.test(t), len: t.length, excerpt: t.slice(0, 300) };
  await ctx.close();
}

await browser.close();
fs.writeFileSync(new URL("./probes.json", import.meta.url), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1).slice(0, 3000));
