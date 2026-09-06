/* 페르소나 실사용 드라이버 — 랜딩 → 온보딩 6단계 → 결과 → 상세 → 뒤로 를 실제 클릭으로 수행 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OCC_NAME = {
  employee_office: "사무직·전문직",
  employee_field: "현장·생산·서비스직",
  self_employed: "자영업·소상공인",
  farmer_fisher: "농림어업인",
  freelancer: "프리랜서·특수고용",
  student: "학생",
  jobseeker: "구직자·무직",
  homemaker: "주부",
  public_servant: "공무원·군인",
  medical: "보건·의료",
  education: "교육",
  retired: "은퇴·연금생활",
};

const personas = JSON.parse(fs.readFileSync(new URL("./personas.json", import.meta.url), "utf8"));
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const targets = only ? personas.filter((p) => only.has(p.id)) : personas;

const out = [];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

for (const p of targets) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: "ko-KR",
  });
  const page = await ctx.newPage();
  const rec = { id: p.id, name: p.name, age: p.age, occ: p.occupation, region: `${p.sido} ${p.sigungu}`, query: p.query, taps: 0, console: [], api: [], notes: [] };
  const tap = async (fn) => { rec.taps += 1; await fn(); };
  page.on("console", (m) => { if (m.type() === "error") rec.console.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.url().includes("/api/")) rec.api.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`); });

  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await tap(() => page.getByRole("link", { name: "1분 만에 확인하기" }).first().click());
    await page.waitForURL("**/onboarding");

    // 1 나이
    await tap(() => page.fill("#age", String(p.age)));
    rec.focusAfterStep = [];
    await tap(() => page.getByRole("button", { name: "다음 →" }).click());
    rec.focusAfterStep.push(await page.evaluate(() => document.activeElement?.tagName ?? "?"));

    // 2 성별
    const g = p.gender === "M" ? "남성" : p.gender === "F" ? "여성" : "선택 안 함";
    await tap(() => page.getByText(g, { exact: true }).click());
    await tap(() => page.getByRole("button", { name: "다음 →" }).click());

    // 3 직업
    await tap(() => page.getByText(OCC_NAME[p.occupation], { exact: true }).click());
    await tap(() => page.getByRole("button", { name: "다음 →" }).click());

    // 4 지역
    await tap(() => page.selectOption("#sido", { label: p.sido }));
    await tap(() => page.selectOption("#sigungu", { label: p.sigungu }));
    await tap(() => page.getByRole("button", { name: "다음 →" }).click());

    // 5 소득
    if (p.unknownDecile) {
      await tap(() => page.getByText("소득분위를 모릅니다", { exact: true }).click());
    } else {
      await tap(() => page.getByText(`${p.decile}분위`, { exact: true }).click());
    }
    if (p.household != null && p.income != null) {
      // 계산기가 화면 아래에 있어 스크롤이 필요한지 기록한다
      const box = await page.locator('input[type="number"]').nth(0).boundingBox();
      rec.calculatorBelowFold = box ? box.y > 844 : null;
      await tap(() => page.locator('input[type="number"]').nth(0).fill(String(p.household)));
      await tap(() => page.locator('input[type="number"]').nth(1).fill(String(p.income)));
      rec.medianText = await page.locator("p[aria-live='polite']").first().innerText().catch(() => null);
    }
    await tap(() => page.getByRole("button", { name: "다음 →" }).click());

    // 6 원하는 것
    if (p.query) {
      await tap(() => page.fill("#query", p.query));
      await tap(() => page.getByRole("button", { name: "결과 보기" }).click());
    } else {
      await tap(() => page.getByRole("button", { name: "건너뛰기" }).click());
    }
    await page.waitForURL("**/results");
    await page.waitForSelector("h1", { timeout: 15000 });
    await page.waitForTimeout(700);
    rec.msToResults = Date.now() - t0;

    // ---- 결과 화면 수확 ----
    rec.h1 = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ");
    rec.total = Number((rec.h1.match(/(\d+)건/) ?? [])[1] ?? -1);
    rec.tabs = await page.locator("nav[aria-label='분류별 좁혀보기'] button").allInnerTexts()
      .then((a) => a.map((s) => s.replace(/\s+/g, " ").trim()));
    rec.cards = await page.locator("section[aria-label='매칭 결과'] > ul > li").evaluateAll((els) =>
      els.map((el) => {
        const t = el.querySelector("h3")?.innerText?.trim() ?? "";
        const sum = el.querySelector("h3 + p")?.innerText?.trim() ?? "";
        const reason = el.querySelector(".border-t p")?.innerText?.replace(/\s+/g, " ").trim() ?? "";
        const badges = [...el.querySelectorAll(".border-t li")].map((b) => b.innerText.trim());
        return { t, sum, reason, badges };
      }),
    );
    rec.nearMiss = await page.locator("#nearmiss-heading").innerText().catch(() => null);
    rec.nearMissItems = await page.locator("section[aria-labelledby='nearmiss-heading'] > ul > li h3").allInnerTexts().catch(() => []);
    rec.notices = await page.locator("p[role='status'], div[role='status']").allInnerTexts()
      .then((a) => a.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean));
    rec.bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    rec.intentHidden = /관련이 적어/.test(rec.bodyText);
    rec.hScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // 첫 카드 상세 → 뒤로 (탭·스크롤 유지 확인)
    if (rec.cards.length > 0) {
      await page.evaluate(() => window.scrollTo(0, 1200));
      /*
        화면 안에 이미 보이는 카드를 고른다. Playwright 는 클릭 전에 대상을 화면으로 끌어오므로
        맨 위 카드를 누르면 스크롤이 먼저 달라져 "떠날 때 위치" 자체가 바뀐다 — 그러면 복원이
        맞아도 틀린 것처럼 보인다.
      */
      const links = page.locator("section[aria-label='매칭 결과'] > ul > li h3 a");
      let picked = 0;
      for (let i = 0; i < (await links.count()); i++) {
        const box = await links.nth(i).boundingBox();
        if (box && box.y > 60 && box.y < 700) { picked = i; break; }
      }
      const beforeY = await page.evaluate(() => Math.round(window.scrollY));
      await tap(() => links.nth(picked).click());
      await page.waitForURL("**/programs/**");
      // 화면이 실제로 기억한 위치. Playwright 가 클릭 직전에 대상을 끌어와 스크롤이 조금
      // 달라질 수 있으므로, 복원 여부는 "떠날 때 기억한 값" 과 대조해야 정확하다.
      rec.storedY = await page.evaluate(() => {
        try {
          return JSON.parse(sessionStorage.getItem("amuguna.results.scroll") ?? "null")?.y ?? null;
        } catch {
          return null;
        }
      });
      rec.detailH1 = await page.locator("h1").first().innerText().catch(() => "");
      rec.detailHasApply = await page.getByRole("link", { name: /신청/ }).count().then((n) => n > 0);
      await tap(() => page.goBack());
      await page.waitForURL("**/results*");
      await page.waitForTimeout(500);
      const afterY = await page.evaluate(() => Math.round(window.scrollY));
      rec.scrollKept = { beforeY, storedY: rec.storedY, afterY, restored: rec.storedY === afterY };
      rec.backReFetched = rec.api.filter((a) => a.includes("/api/match")).length;
    }
  } catch (e) {
    rec.error = String(e).split("\n").slice(0, 3).join(" | ");
  }
  rec.apiCalls = rec.api.length;
  out.push(rec);
  console.log(`${p.id} ${p.name} → total=${rec.total ?? "-"} taps=${rec.taps} ${rec.error ? "ERR " + rec.error.slice(0, 90) : ""}`);
  await ctx.close();
}
await browser.close();
fs.writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("saved", out.length);
