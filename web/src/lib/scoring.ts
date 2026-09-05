/**
 * 종합 점수: 질문 없는 추천순은 네 항목 각각 25%.
 * 질문이 있는 날짜 정렬의 동점 처리는 기존 §7.4 가중치를 유지한다.
 *
 *   score = 0.30 · 유사도       (질문이 있는 날짜 정렬의 동점 처리)
 *         + 0.25 · 조건_구체성  (내 속성 중 몇 개가 매칭에 관여했나)
 *         + 0.20 · 지역_근접성  (기초 > 광역 > 전국)
 *         + 0.15 · 금액_규모    (log 정규화)
 *         + 0.10 · 마감_임박도  (D-7 이내 가산, 상시 중립)
 *
 * 가중치 초기값이며 페르소나 3종 골든셋으로 튜닝한다 (§10).
 */
import type { Profile, Program, RuleDimension, ScoreBreakdown } from "./types";
import { RULE_DIMENSIONS, dDay, regionPrefixes } from "./eligibility";

export const WEIGHTS = {
  similarity: 0.3,
  specificity: 0.25,
  regionProximity: 0.2,
  amountScale: 0.15,
  deadlineUrgency: 0.1,
} as const;

/** 금액 로그 정규화 상한 — 1억원에서 1.0에 도달 */
const AMOUNT_CAP = 100_000_000;

/** 조건_구체성: 매칭에 관여한 내 속성 수 / 5 */
export function specificityScore(matched: RuleDimension[]): number {
  return matched.length / RULE_DIMENSIONS.length;
}

/** 지역_근접성: 기초(5자리) > 광역(2자리) > 전국(NULL) */
export function regionProximityScore(
  regions: string[] | null,
  p: Profile,
): number {
  if (!regions || regions.length === 0) return 0.3; // 전국
  const mine = regionPrefixes(p);
  if (regions.some((c) => c.length === 5 && mine.includes(c))) return 1.0; // 기초
  if (regions.some((c) => c.length === 2 && mine.includes(c))) return 0.65; // 광역
  return 0.3;
}

/** 금액_규모: log 정규화. 금액 정보가 없으면 중립값 */
export function amountScaleScore(prog: Program): number {
  const amount = prog.benefit_amount_max ?? prog.benefit_amount_min ?? null;
  if (amount === null || amount <= 0) return 0.35;
  const s = Math.log10(1 + amount) / Math.log10(1 + AMOUNT_CAP);
  return Math.max(0, Math.min(1, s));
}

/**
 * 마감_임박도: D-7 이내 가산, 상시 중립.
 * 상시(is_always_open/기한 없음) = 0.5 중립. D-7 이내 = 1.0.
 * 그 밖은 남은 일수에 따라 0.5까지 선형 감쇠 (60일 이후 중립과 동일).
 */
export function deadlineUrgencyScore(prog: Program, now = new Date()): number {
  const d = dDay(prog, now);
  if (d === null) return 0.5;
  if (d < 0) return 0;
  if (d <= 7) return 1.0;
  const decayed = 1.0 - ((d - 7) / 60) * 0.5;
  return Math.max(0.5, decayed);
}

/**
 * 가중 합산. hasQuery=false 면 유사도 항을 빼고 나머지 가중치를 정규화한다
 * (0.25/0.20/0.15/0.10 의 합 0.70 으로 나눔).
 */
export function combine(
  parts: Omit<ScoreBreakdown, "total">,
  hasQuery: boolean,
): ScoreBreakdown {
  let total: number;
  if (hasQuery) {
    total =
      WEIGHTS.similarity * parts.similarity +
      WEIGHTS.specificity * parts.specificity +
      WEIGHTS.regionProximity * parts.regionProximity +
      WEIGHTS.amountScale * parts.amountScale +
      WEIGHTS.deadlineUrgency * parts.deadlineUrgency;
  } else {
    total =
      (parts.specificity + parts.regionProximity + parts.amountScale + parts.deadlineUrgency) / 4;
  }
  return { ...parts, total };
}

export function scoreProgram(
  prog: Program,
  profile: Profile,
  matched: RuleDimension[],
  sim: number,
  hasQuery: boolean,
  now = new Date(),
): ScoreBreakdown {
  return combine(
    {
      similarity: hasQuery ? Math.max(0, Math.min(1, sim)) : 0,
      specificity: specificityScore(matched),
      regionProximity: regionProximityScore(prog.rules.regions, profile),
      amountScale: amountScaleScore(prog),
      deadlineUrgency: deadlineUrgencyScore(prog, now),
    },
    hasQuery,
  );
}
