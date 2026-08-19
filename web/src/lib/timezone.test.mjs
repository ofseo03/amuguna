/**
 * 마감일 경계 — 전 경로 Asia/Seoul 고정 (SPEC §5, §7.3).
 *
 * `ends_at` 은 시각이 없는 달력 날짜다(Postgres `date`). 이 값을 전체 타임스탬프로
 * 바꾸면 UTC 자정이라는 있지도 않은 시각이 생겨 **KST 00:00~09:00 구간에서 하루가 밀린다.**
 * 같은 공고가 같은 날에 D-2 로도 D-1 로도 보이는 비일관성이 되고, 심사위원마다 다른
 * 화면을 보게 된다.
 *
 * 아래는 그 회귀를 막는 경계 테스트다. 마감일은 **그 날짜의 KST 23:59:59 까지** 유효하다.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dDay, isOpen, kstDate, toDateString } from "./eligibility.ts";
import { formatDate, formatDateTime, dDayLabel } from "./format.ts";

const open = (ends_at, starts_at = null) => ({
  status: "active",
  is_always_open: false,
  starts_at,
  ends_at,
});

/** KST 벽시계 시각을 UTC Date 로 */
const kst = (isoLocal) => new Date(`${isoLocal}+09:00`);

/* ------------------------------------------------------- 날짜 정규화 */

test("DB 의 date 값은 어떤 형태로 오든 날짜 문자열로 정규화된다", () => {
  // postgres.js 는 date 컬럼을 UTC 자정 Date 로 파싱한다
  assert.equal(toDateString(new Date("2026-08-14T00:00:00.000Z")), "2026-08-14");
  assert.equal(toDateString("2026-08-14"), "2026-08-14");
  assert.equal(toDateString("2026-08-14T00:00:00.000Z"), "2026-08-14");
  assert.equal(toDateString(null), null);
  assert.equal(toDateString(undefined), null);
  assert.equal(toDateString("상시"), null);
  assert.equal(toDateString(new Date("nope")), null);
});

test("KST 달력 날짜는 UTC 자정 전후로 정확히 바뀐다", () => {
  assert.equal(kstDate(new Date("2026-08-13T14:59:59Z")), "2026-08-13"); // KST 23:59:59
  assert.equal(kstDate(new Date("2026-08-13T15:00:00Z")), "2026-08-14"); // KST 00:00:00
});

/* --------------------------------------------------- 오늘 / 어제 / 내일 */

test("오늘 마감 공고는 KST 하루 내내 열려 있고 D-0 이다", () => {
  const today = "2026-08-14";
  const program = open(today);
  for (const at of ["00:00:00", "09:00:00", "12:00:00", "20:00:00", "23:59:59"]) {
    const now = kst(`${today}T${at}`);
    assert.equal(isOpen(program, now), true, `KST ${at} 에 닫혀 있다`);
    assert.equal(dDay(program, now), 0, `KST ${at} 의 D-day 가 0 이 아니다`);
    assert.equal(dDayLabel(dDay(program, now)), "오늘 마감");
  }
});

test("어제 마감 공고는 KST 자정을 넘긴 순간부터 닫힌다", () => {
  const program = open("2026-08-13");
  // 마감일 마지막 1초까지는 열려 있다
  assert.equal(isOpen(program, kst("2026-08-13T23:59:59")), true);
  assert.equal(dDay(program, kst("2026-08-13T23:59:59")), 0);
  // 자정을 넘기면 닫힌다
  assert.equal(isOpen(program, kst("2026-08-14T00:00:00")), false);
  assert.equal(dDay(program, kst("2026-08-14T00:00:00")), -1);
  assert.equal(dDayLabel(-1), "마감");
  // UTC 자정(=KST 09:00)에도 판정이 바뀌지 않아야 한다 — 여기가 옛 버그 지점이다
  assert.equal(isOpen(program, kst("2026-08-14T09:00:00")), false);
  assert.equal(dDay(program, kst("2026-08-14T09:00:00")), -1);
});

test("내일 마감 공고는 하루 중 어느 시각에 봐도 D-1 이다", () => {
  const program = open("2026-08-14");
  const seen = new Set();
  for (const at of ["00:00:01", "01:00:00", "08:59:59", "09:00:01", "18:00:00", "23:59:59"]) {
    const now = kst(`2026-08-13T${at}`);
    assert.equal(isOpen(program, now), true);
    seen.add(dDay(program, now));
  }
  // 회귀 지점: 예전에는 KST 09:00 을 경계로 D-2 와 D-1 이 갈렸다
  assert.deepEqual([...seen], [1], `같은 날인데 D-day 가 갈린다: ${[...seen].join(", ")}`);
});

test("접수 시작 전 공고는 시작일 KST 00:00 부터 열린다", () => {
  const program = open("2026-08-20", "2026-08-15");
  assert.equal(isOpen(program, kst("2026-08-14T23:59:59")), false);
  assert.equal(isOpen(program, kst("2026-08-15T00:00:00")), true);
});

test("상시 공고와 마감일 없는 공고는 D-day 가 없다", () => {
  const always = { status: "active", is_always_open: true, starts_at: null, ends_at: "2026-08-14" };
  assert.equal(dDay(always), null);
  assert.equal(dDayLabel(null), "상시");
  const noEnd = open(null);
  assert.equal(dDay(noEnd), null);
  assert.equal(isOpen(noEnd, kst("2030-01-01T00:00:00")), true);
});

/* --------------------------------------------------------- 표기 일관성 */

test("날짜 표기는 브라우저 타임존과 무관하게 같은 날짜를 찍는다", () => {
  // 달력 날짜는 문자열을 그대로 쪼갠다 — Date 파싱을 거치지 않으므로 타임존 영향이 없다
  assert.equal(formatDate("2026-08-14"), "2026. 8. 14.");
  assert.equal(formatDate("2026-01-01"), "2026. 1. 1.");
  assert.equal(formatDate(null), "-");
});

test("수집 시각은 KST 로 표기한다", () => {
  // 2026-08-13 23:30 UTC = 2026-08-14 08:30 KST
  assert.equal(formatDateTime("2026-08-13T23:30:00Z"), "2026. 8. 14. 08:30");
  // 2026-08-13 14:59 UTC = 2026-08-13 23:59 KST
  assert.equal(formatDateTime("2026-08-13T14:59:00Z"), "2026. 8. 13. 23:59");
});

/* ------------------------------------------------- SQL 과 앱의 일치 */

test("앱의 마감 판정이 SQL 필터와 같은 경계를 쓴다", async () => {
  // SQL: ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date
  // 앱:  ends_at >= kstDate(now)
  // 두 식이 같은 문자열 비교가 되도록 ends_at 을 날짜로 정규화하는 것이 전제다.
  const { readFile } = await import("node:fs/promises");
  const matching = await readFile(new URL("./matching.ts", import.meta.url), "utf8");
  assert.match(matching, /now\(\) AT TIME ZONE 'Asia\/Seoul'/);
  assert.match(
    matching,
    /starts_at: toDateString\(r\.starts_at\)/,
    "date 컬럼을 타임스탬프로 되돌리면 하루 밀림이 재발한다",
  );
  assert.match(matching, /ends_at: toDateString\(r\.ends_at\)/);

  // 실제 경계 확인: KST 로 오늘인 날짜는 SQL 에서도 앱에서도 '오늘'이다
  const now = kst("2026-08-14T02:00:00"); // UTC 로는 아직 8/13
  assert.equal(kstDate(now), "2026-08-14");
  assert.equal(isOpen(open("2026-08-14"), now), true);
  assert.equal(isOpen(open("2026-08-13"), now), false);
});
