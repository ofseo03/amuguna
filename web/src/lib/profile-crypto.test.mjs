/**
 * 프로필 쿠키 암호화와 CSRF 방어 (SPEC §8).
 *
 * 프로필(나이·성별·직업·지역·소득분위)은 준식별정보다. "서버에 저장하지 않는다"가
 * 이 서비스의 핵심 주장인데, 저장하지 않는 대신 평문으로 클라이언트에 상주시키고 매 요청
 * 보내면 주장이 약해진다. 서명은 위변조를 탐지할 뿐 내용을 가리지 못한다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  deserializeProfile,
  isLegacyProfileCookie,
  serializeProfile,
  sessionSecret,
} from "./session.ts";
import { CSRF_MESSAGE, checkCsrf } from "./csrf.ts";

const PROFILE = {
  age: 28,
  gender: "F",
  occupation: "employee_office",
  sidoCode: "11",
  sigunguCode: "11620",
  incomeDecile: 3,
  medianIncomePercent: 120,
};

/* ------------------------------------------------------------ 암호화 */

test("프로필은 왕복해도 값이 보존된다", () => {
  const restored = deserializeProfile(serializeProfile(PROFILE));
  assert.deepEqual(restored, PROFILE);
});

test("쿠키에서 프로필 값을 읽어낼 수 없다 (서명이 아니라 암호화다)", () => {
  const cookie = serializeProfile(PROFILE);

  // 쿠키 문자열 어디에도 평문 값이 드러나지 않아야 한다
  for (const secret of ["employee_office", "11620", '"age":28', "medianIncomePercent"]) {
    assert.ok(!cookie.includes(secret), `쿠키에 평문 '${secret}' 이 보인다`);
  }

  // base64url 로 디코드해도 JSON 이 나오면 안 된다 — 서명 방식의 실패 모드가 이것이다
  const payload = Buffer.from(cookie.slice(cookie.indexOf(".") + 1), "base64url").toString("utf8");
  assert.ok(!payload.includes("occupation"), "복호화 없이 프로필 필드가 읽힌다");
  assert.throws(() => JSON.parse(payload), "암호문이 그대로 JSON 으로 파싱된다");
});

test("같은 프로필도 매번 다른 쿠키가 된다 (nonce 재사용 없음)", () => {
  // 같은 값이 항상 같은 쿠키가 되면 쿠키를 보는 것만으로 두 사용자가 같은 프로필인지 알 수 있다
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(serializeProfile(PROFILE));
  assert.equal(seen.size, 20);
});

test("변조된 쿠키는 거부된다", () => {
  const cookie = serializeProfile(PROFILE);
  const body = cookie.slice(cookie.indexOf(".") + 1);
  const bytes = Buffer.from(body, "base64url");

  // 암호문 중간 바이트를 뒤집는다 — GCM 인증 태그가 잡아야 한다
  const tampered = Buffer.from(bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  assert.equal(deserializeProfile(`v1.${tampered.toString("base64url")}`), null);

  // 잘린 쿠키, 빈 쿠키, 쓰레기 값
  assert.equal(deserializeProfile(`v1.${bytes.subarray(0, 8).toString("base64url")}`), null);
  assert.equal(deserializeProfile("v1."), null);
  assert.equal(deserializeProfile("v1.!!!not-base64!!!"), null);
  assert.equal(deserializeProfile(undefined), null);
  assert.equal(deserializeProfile(""), null);
});

test("다른 키로 만든 쿠키는 읽히지 않는다", () => {
  // 키가 갈리면 조용히 통과시키는 대신 확실히 실패해야 한다
  const forged = "v1." + Buffer.alloc(64, 7).toString("base64url");
  assert.equal(deserializeProfile(forged), null);
});

/* --------------------------------------------------- 구형 쿠키 호환 */

test("암호화 이전에 발급된 서명 쿠키도 읽되, 구형으로 표시한다", () => {
  // 심사 구간에 이미 브라우저에 남아 있는 쿠키를 무효화하면 온보딩을 다시 하게 된다
  const payload = Buffer.from(JSON.stringify(PROFILE), "utf8").toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const legacy = `${payload}.${signature}`;

  assert.deepEqual(deserializeProfile(legacy), PROFILE);
  assert.equal(isLegacyProfileCookie(legacy), true);
  assert.equal(isLegacyProfileCookie(serializeProfile(PROFILE)), false);

  // 서명이 틀린 구형 쿠키는 여전히 거부한다
  assert.equal(deserializeProfile(`${payload}.wrongsignature`), null);
});

/* ---------------------------------------------------------- CSRF */

function request(headers) {
  return new Request("https://amuguna.example/api/match", { method: "POST", headers });
}

test("같은 출처의 요청은 통과한다", () => {
  assert.equal(checkCsrf(request({ host: "amuguna.example", origin: "https://amuguna.example" })).ok, true);
  assert.equal(
    checkCsrf(request({ "x-forwarded-host": "amuguna.example", "x-forwarded-proto": "https", origin: "https://amuguna.example" })).ok,
    true,
  );
  assert.equal(checkCsrf(request({ host: "amuguna.example", "sec-fetch-site": "same-origin" })).ok, true);
});

test("다른 출처의 요청은 거부한다", () => {
  const crossOrigin = checkCsrf(
    request({ host: "amuguna.example", origin: "https://evil.example" }),
  );
  assert.equal(crossOrigin.ok, false);
  assert.match(crossOrigin.reason, /evil\.example/);

  // 브라우저가 스스로 크로스사이트라고 알려준 경우
  const crossSite = checkCsrf(
    request({ host: "amuguna.example", "sec-fetch-site": "cross-site" }),
  );
  assert.equal(crossSite.ok, false);
});

test("Origin 헤더가 없는 요청은 막지 않는다", () => {
  // 헤더가 없다고 막으면 구형 브라우저·프록시 뒤 정상 사용자가 차단된다.
  // 그 경우는 SameSite=Lax 가 이미 쿠키를 싣지 않는 것으로 막고 있다.
  assert.equal(checkCsrf(request({ host: "amuguna.example" })).ok, true);
  assert.equal(checkCsrf(request({ host: "amuguna.example", origin: "null" })).ok, true);
});

test("거부 문구는 공격을 단정하지 않는다", () => {
  // 정상 사용자가 프록시 때문에 걸렸을 수도 있다
  assert.match(CSRF_MESSAGE, /다시 시도/);
  assert.ok(!/공격|차단됨|금지/.test(CSRF_MESSAGE));
});

/* -------------------------------------------------- 쿠키 속성 계약 */

test("프로필 쿠키는 httpOnly + SameSite 로 발급된다", async () => {
  const { readFile } = await import("node:fs/promises");
  const session = await readFile(new URL("./session.ts", import.meta.url), "utf8");
  assert.match(session, /httpOnly: true/);
  assert.match(session, /sameSite: "lax" as const/);
  assert.match(session, /secure: process\.env\.NODE_ENV === "production"/);
});

test("모든 POST 라우트가 CSRF 검사를 거친다", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const route of [
    "../app/api/match/route.ts",
    "../app/api/profile/route.ts",
    "../app/api/answer/route.ts",
  ]) {
    const code = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(code, /checkCsrf\(req\)/, `${route} 에 CSRF 검사가 없다`);
    assert.match(code, /status: 403/, `${route} 가 CSRF 거부를 403 으로 돌려주지 않는다`);
  }
});

test("http 로 접속하는 환경을 차단하지 않는다", () => {
  // 회귀 방지: X-Forwarded-Proto 가 없을 때 스킴을 https 로 추측하면
  // 로컬 http 개발과 사내망 IP 접속이 전부 403 이 된다. 실제로 그랬다.
  for (const host of ["127.0.0.1:3000", "192.168.0.5:3000", "10.0.0.7:3000", "localhost:3000"]) {
    const result = checkCsrf(request({ host, origin: `http://${host}` }));
    assert.equal(result.ok, true, `${host} 가 차단되었다: ${result.reason}`);
  }
});

test("스킴이 달라도 호스트가 같으면 통과한다", () => {
  // CSRF 가 가려야 하는 것은 '어느 사이트가 보냈는가'다. 스킴 다운그레이드는
  // HSTS 와 CSP 의 upgrade-insecure-requests 가 맡는 별개의 문제다.
  const host = "amuguna.example";
  assert.equal(checkCsrf(request({ host, origin: `http://${host}` })).ok, true);
  assert.equal(checkCsrf(request({ host, origin: `https://${host}` })).ok, true);
});

test("포트가 다르면 다른 출처로 본다", () => {
  const result = checkCsrf(request({ host: "amuguna.example:3000", origin: "https://amuguna.example:4000" }));
  assert.equal(result.ok, false);
});

test("Origin 이 URL 형식이 아니면 거부한다", () => {
  // 'null' 은 통과시키지만(§ 위 테스트), 파싱 불가한 쓰레기 값은 신뢰하지 않는다
  const result = checkCsrf(request({ host: "amuguna.example", origin: "not-a-url" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /형식 오류/);
});
