/**
 * 결과 내 검색 정렬 — 이미 뽑아 놓은 결과를 검색어에 맞게 다시 줄 세운다.
 *
 * 온보딩의 "원하는 것" 한 줄은 임베딩으로 **집합 B 를 정의**한다 — 결과를 좁히는 장치다.
 * 이 모듈은 그것과 다르다. 후보 집합은 손대지 않고 **순서만** 바꾼다. 임베딩을 쓰지 않고,
 * 카드에 실제로 보이는 글자(제목·요약·기관명·지원금액 문구)에 검색어가 들어 있는지만 본다.
 *
 * 임베딩이 아니라 글자 대조인 이유:
 *  - 결과 화면에서 사람이 찾는 건 대개 "전세", "청년", "관악구" 같은 **낱말**이다.
 *    유사도는 왜 그 순서인지 설명할 수 없지만, 글자 대조는 화면에서 그대로 확인된다.
 *  - 의도 축은 이미 임베딩을 쓴다. 같은 축을 한 번 더 걸면 결과가 두 번 눌린다.
 *  - 질의 임베딩은 외부 API 호출(최대 15초)이다. 결과를 다시 정렬할 때마다 부를 일이 아니다.
 *
 * **정렬이지 필터가 아니다.** 검색어와 맞지 않는 건은 아래로 내려갈 뿐 사라지지 않는다.
 * 대상인데 몰라서 못 받는 것을 없애자는 서비스가 낱말 하나로 대상인 것을 숨기면 안 된다(§5).
 *
 * 이 파일의 공식은 `db/migrations/0014_keyword_sort.sql` 의 `match_program_page()` 와
 * **완전히 같아야 한다.** 데모 모드는 여기서, DB 모드는 SQL 에서 같은 점수를 낸다.
 */
import type { Program } from "./types";

/** 한 번에 반영하는 낱말 수 상한. 넘는 건 버린다 — 낱말이 늘수록 평균이 희석되기만 한다. */
export const MAX_SORT_TOKENS = 8;

/**
 * 검색어가 나온 자리별 점수. 한 낱말의 점수는 이 중 **최댓값** 하나다(합산이 아니다).
 * 제목에 있는 낱말과 기관명에만 있는 낱말은 사람이 체감하는 관련도가 다르다.
 */
export const FIELD_WEIGHTS = {
  title: 1.0,
  summary: 0.6,
  issuer: 0.5,
  benefit: 0.35,
} as const;

/**
 * 검색어 점수와 §7.4 스코어를 합치는 가중치.
 *
 * 검색어 점수는 소수 둘째 자리로 끊으므로 서로 다른 값의 최소 간격이 0.01 이고,
 * `0.995 × 0.01 = 0.00995` 는 §7.4 스코어가 만들 수 있는 최대 차이 `0.005 × 1` 보다 크다.
 * 그래서 **검색어가 항상 먼저, §7.4 스코어는 동점일 때만** 순서를 정한다 — 사용자가 낱말을
 * 넣었는데 지원금액이 큰 건이 위로 새치기하면 "검색어에 맞게 정렬"이 아니다.
 * 두 항 모두 0~1 이라 합도 0~1 이고, keyset 커서(0~1 검증)가 그대로 유효하다.
 */
export const KEYWORD_WEIGHT = 0.995;
export const BASE_WEIGHT = 0.005;

/** 소수 둘째 자리 절사 — 검색어 점수의 눈금. SQL 의 `round(x, 2)` 와 같다. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * 검색어를 낱말로 쪼갠다.
 *
 * NFC 정규화 → 소문자화 → 한글·영문자·숫자가 아닌 글자를 공백으로 → 공백 분리.
 * 한 글자짜리는 조사·어미와 겹쳐 아무 데나 걸리므로 두 글자 이상만 쓴다.
 * 다만 전부 한 글자면(예: "집") 그대로 쓴다 — 아무것도 정렬하지 않는 것보다 낫다.
 */
export function sortTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const normalized = raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gu, " ")
    .trim();
  if (normalized.length === 0) return [];
  const parts = normalized.split(" ").filter(Boolean);
  const long = parts.filter((t) => t.length >= 2);
  return [...new Set(long.length > 0 ? long : parts)].slice(0, MAX_SORT_TOKENS);
}

/** 대소문자만 맞추고 부분 문자열로 본다 — SQL 의 `strpos(lower(field), token) > 0` 과 같다. */
function has(field: string | null | undefined, token: string): boolean {
  return typeof field === "string" && field.toLowerCase().includes(token);
}

/**
 * 낱말별 최고 자리 점수의 평균 (0~1).
 *
 * 낱말 두 개 중 하나만 제목에 있으면 0.5 다 — 전부 맞은 건이 일부만 맞은 건보다 항상 위로 간다.
 */
export function keywordScore(program: Program, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const token of tokens) {
    if (has(program.title, token)) sum += FIELD_WEIGHTS.title;
    else if (has(program.summary, token)) sum += FIELD_WEIGHTS.summary;
    else if (has(program.issuer, token)) sum += FIELD_WEIGHTS.issuer;
    else if (has(program.benefit_amount_text, token)) sum += FIELD_WEIGHTS.benefit;
  }
  return round2(sum / tokens.length);
}

/**
 * 최종 정렬 점수. 검색어가 없으면 §7.4 스코어 그대로다 — 기본 화면은 조금도 달라지지 않는다.
 *
 * 한 건도 검색어에 걸리지 않아도 순서가 흐트러지지 않는다: 전부 `keyword = 0` 이라
 * `BASE_WEIGHT × base` 만 남고, 이는 §7.4 스코어에 양의 상수를 곱한 것이라 순서가 같다.
 */
export function blendSortScore(base: number, keyword: number, active: boolean): number {
  if (!active) return base;
  return KEYWORD_WEIGHT * keyword + BASE_WEIGHT * base;
}
