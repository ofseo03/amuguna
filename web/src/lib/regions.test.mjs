/**
 * 행정표준코드(법정동코드) 정적 데이터 검증 (SPEC §6.1).
 *
 * 이 표가 낡으면 **조용히** 틀린다. 사용자가 고른 지역코드와 공고에서 추출한 지역코드가
 * 서로 다른 체계를 가리키면 `e.regions && :region_prefixes` 가 매칭되지 않고, 정당한
 * 대상자가 결과에서 빠진다. 화면에는 "해당 지원이 없습니다"로만 보인다.
 *
 * 특히 위험한 것은 시군구 통폐합·관할 이관이다. 최근 사례:
 *   - 2023-06 강원특별자치도 (42 → 51)
 *   - 2024-01 전북특별자치도 (45 → 52)
 *   - 2023-07 군위군 경북 → 대구 (47 → 27)
 * 구버전 표를 쓰면 이 지역 사용자가 통째로 누락된다.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const regions = JSON.parse(
  await readFile(new URL("../data/regions.json", import.meta.url), "utf8"),
);

test("출처와 기준일자가 파일 안에 명시돼 있다", () => {
  assert.equal(regions.source.issuer, "행정안전부");
  assert.match(regions.source.url, /^https:\/\//);
  // 기준일자가 없으면 언제 갱신해야 하는지 아무도 모른다
  assert.match(regions.source.snapshot_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("시도는 17개이며 코드는 2자리다", () => {
  assert.equal(regions.sido.length, 17);
  for (const { code, name } of regions.sido) {
    assert.match(code, /^\d{2}$/, `${name} 시도 코드가 2자리가 아니다`);
    assert.ok(name.length > 0);
  }
  assert.equal(new Set(regions.sido.map((s) => s.code)).size, 17, "시도 코드가 중복된다");
});

test("시군구 코드는 5자리이고 앞 2자리가 실제 시도 코드다", () => {
  // §7.3 의 `&&` 는 원소 동등 비교라 양쪽이 같은 자리수 체계를 써야만 매칭된다.
  const sidoCodes = new Set(regions.sido.map((s) => s.code));
  for (const { code, name, sido } of regions.sigungu) {
    assert.match(code, /^\d{5}$/, `${name} 시군구 코드가 5자리가 아니다`);
    assert.equal(code.slice(0, 2), sido, `${name}(${code})의 sido 필드가 코드 앞자리와 다르다`);
    assert.ok(sidoCodes.has(sido), `${name}(${code})의 시도 코드 ${sido} 가 시도 목록에 없다`);
  }
  assert.equal(
    new Set(regions.sigungu.map((s) => s.code)).size,
    regions.sigungu.length,
    "시군구 코드가 중복된다",
  );
});

test("모든 시도에 최소 1개의 시군구가 있다", () => {
  // 세종특별자치시처럼 하위 시군구가 없는 광역단체도 목록에는 자기 자신이 들어와야
  // 온보딩 2단계에서 선택지가 비지 않는다.
  const bySido = new Map();
  for (const { sido } of regions.sigungu) bySido.set(sido, (bySido.get(sido) ?? 0) + 1);
  for (const { code, name } of regions.sido) {
    assert.ok(bySido.get(code) > 0, `${name}(${code})에 시군구가 하나도 없다`);
  }
});

test("최근 개편이 반영된 최신 표다", () => {
  const codes = new Map(regions.sigungu.map((s) => [s.code, s.name]));
  const sido = new Map(regions.sido.map((s) => [s.code, s.name]));

  // 강원특별자치도(51)·전북특별자치도(52) — 구코드 42/45 가 남아 있으면 구버전이다
  assert.ok(sido.has("51"), "강원특별자치도(51)가 없다 — 2023-06 개편 미반영");
  assert.ok(sido.has("52"), "전북특별자치도(52)가 없다 — 2024-01 개편 미반영");
  assert.ok(!sido.has("42"), "폐지된 강원도 코드(42)가 남아 있다");
  assert.ok(!sido.has("45"), "폐지된 전라북도 코드(45)가 남아 있다");

  // 군위군은 2023-07 경북(47) → 대구(27) 이관
  assert.equal(codes.get("27720"), "군위군", "군위군의 대구 이관(27720)이 반영되지 않았다");
  assert.ok(
    ![...codes.keys()].some((code) => code.startsWith("47") && codes.get(code) === "군위군"),
    "경북 소속 군위군이 남아 있다 — 구버전 표다",
  );

  // 전주시가 전북특별자치도(52) 아래에 있어야 한다
  assert.ok(
    [...codes.entries()].some(([code, name]) => code.startsWith("52") && name.startsWith("전주시")),
    "전주시가 전북특별자치도(52) 아래에 없다",
  );
});
