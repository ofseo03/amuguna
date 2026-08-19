import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";

import { externalHttpUrl } from "./format.ts";
import { sslOption } from "./db.ts";
import { deserializeSessionId, serializeSessionId, sessionSecret } from "./session.ts";

test("production requires a strong session secret", () => {
  assert.throws(
    () => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "too-short" }),
    /32자 이상/,
  );
  assert.equal(
    sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) }),
    "x".repeat(32),
  );
});

test("session ids are strict UUIDv4 values protected by HMAC", () => {
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const signed = serializeSessionId(id);
  assert.equal(deserializeSessionId(signed), id);
  assert.equal(deserializeSessionId(id), null);
  assert.equal(deserializeSessionId(signed.replace(id, "0f8fad5b-d9cb-469f-a165-70867728950f")), null);
  assert.throws(() => serializeSessionId("00000000-0000-0000-0000-000000000000"), /invalid session/);
});

test("external links only allow http and https", () => {
  assert.equal(externalHttpUrl("https://example.test/path"), "https://example.test/path");
  assert.equal(externalHttpUrl("javascript:alert(1)"), null);
  assert.equal(externalHttpUrl("data:text/html,bad"), null);
  assert.equal(externalHttpUrl("not a url"), null);
});

test("database TLS defaults do not override explicit or local DSNs", () => {
  assert.equal(sslOption("postgres://localhost/app", {}), undefined);
  assert.equal(sslOption("postgres://db.example/app?sslmode=disable", {}), undefined);
  assert.equal(sslOption("host=/var/run/postgresql dbname=app", {}), undefined);
  assert.equal(sslOption("postgres://db.example/app", {}), "verify-full");
});

/* ------------------------------------------------------------------ */
/* 저장형 XSS 방어 (SPEC §8 보안)                                       */
/*                                                                     */
/* body_text·summary·title·issuer 는 전부 공공 API 에서 받아온 외부 텍스트다.  */
/* 공고문에 HTML 이나 스크립트가 섞여 들어올 수 있으므로 렌더 경로가 반드시    */
/* 이스케이프해야 한다. React 는 JSX 보간을 자동 이스케이프하므로 기본은 안전  */
/* 하지만, dangerouslySetInnerHTML 이 하나라도 외부 데이터에 닿으면 뚫린다.   */
/* 주최가 금융보안원이라 이 항목은 치명적 실점이다.                          */
/* ------------------------------------------------------------------ */

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await sourceFiles(next, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
      out.push([next, await readFile(new URL(next, import.meta.url), "utf8")]);
  }
  return out;
}

const SOURCES = await sourceFiles("..");

test("외부 텍스트를 원시 HTML 로 넣는 경로가 없다", () => {
  const offenders = [];
  for (const [path, code] of SOURCES) {
    for (const match of code.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/gu)) {
      const expression = match[1].trim();
      // 허용: 코드에 박힌 상수 하나만. 그 외 표현식은 외부 값이 흘러들 수 있다.
      if (!/^[A-Z][A-Z0-9_]*$/u.test(expression)) offenders.push(`${path}: ${expression}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `외부 데이터가 원시 HTML 로 렌더될 수 있다:\n${offenders.join("\n")}`,
  );
});

test("유일한 dangerouslySetInnerHTML 은 외부 입력이 닿지 않는 정적 부트스트랩이다", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: FONT_SIZE_BOOTSTRAP \}\}/);

  const store = await readFile(new URL("./font-size-store.ts", import.meta.url), "utf8");
  // 템플릿 리터럴 안의 유일한 보간이 JSON.stringify 로 감싼 자체 상수여야 한다.
  assert.match(store, /export const FONT_SIZE_BOOTSTRAP = `/);
  const body = store.slice(store.indexOf("FONT_SIZE_BOOTSTRAP = `"));
  const interpolations = [...body.slice(0, body.indexOf("`;")).matchAll(/\$\{([^}]*)\}/gu)];
  assert.ok(interpolations.length > 0, "보간을 찾지 못했다 — 검사가 무력화됐다");
  for (const [, expression] of interpolations) {
    // 보간은 반드시 `JSON.stringify(대문자상수)` 형태여야 한다. 값이 코드 안에 있고
    // JSON.stringify 가 따옴표까지 escape 하므로 스크립트 문맥을 깨고 나갈 수 없다.
    assert.match(
      expression.replace(/\s+/gu, ""),
      /^JSON\.stringify\([A-Z][A-Z0-9_]*,?\)?$/u,
      `부트스트랩 스크립트에 검증되지 않은 보간이 있다: ${expression}`,
    );
  }
});

test("외부 링크는 렌더 전에 스킴이 검증된다", async () => {
  const detail = await readFile(new URL("../app/programs/[id]/page.tsx", import.meta.url), "utf8");
  // href 에 program.source_url / apply_url 을 그대로 넣으면 javascript: 스킴이 통과한다
  assert.doesNotMatch(detail, /href=\{program\.(source_url|apply_url)\}/u);
  assert.match(detail, /externalHttpUrl\(program\.source_url\)/);
  assert.match(detail, /externalHttpUrl\(program\.apply_url\)/);
});

test("공고문에 섞인 스크립트는 값으로만 취급된다", () => {
  // 렌더 경로가 아니라 링크 정화기의 계약을 고정한다 — 스킴 우회가 실제 위험이다.
  assert.equal(externalHttpUrl("javascript:alert(1)"), null);
  assert.equal(externalHttpUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(externalHttpUrl("vbscript:msgbox(1)"), null);
  assert.equal(externalHttpUrl("  javascript:alert(1)"), null);
  assert.equal(externalHttpUrl("https://www.gov.kr/a?b=1"), "https://www.gov.kr/a?b=1");
});
