/**
 * 자격 판정 (SPEC §7.3), 근접 탈락 문구 (§7.6), 매칭 근거 템플릿 (§7.5).
 *
 * 원칙: NULL = 조건 없음 = 통과. 자격 조건이 명시되지 않은 프로그램은 배제하지 않는다.
 * "누락이 오탐보다 비싸다" — 이 서비스가 푸는 문제가 "받을 수 있는데 몰라서 못 받는 것"이므로.
 *
 * 이 모듈은 데모 모드(번들 JSON)의 판정 엔진이자,
 * DB 모드에서 RPC 가 돌려준 결과를 화면 문구로 옮기는 공통 로직이다.
 */
import type {
  DimensionCheck,
  EligibilityRules,
  Profile,
  Program,
  RuleDimension,
} from "./types";
import {
  decileLabel,
  occupationName,
  regionCodeName,
  shortSido,
  sigunguName,
} from "./shared-data";

export const RULE_DIMENSIONS: RuleDimension[] = [
  "age",
  "gender",
  "region",
  "occupation",
  "income",
];

export const DIMENSION_LABEL: Record<RuleDimension, string> = {
  age: "나이",
  gender: "성별",
  region: "거주지역",
  occupation: "직업",
  income: "소득",
};

/** SPEC §7.3 — 질의용 지역 코드 두 값 [시도 2자리, 시군구 5자리] */
export function regionPrefixes(p: Profile): [string, string] {
  return [p.sidoCode, p.sigunguCode];
}

function passAge(r: EligibilityRules, p: Profile): boolean {
  if (r.age_min !== null && p.age < r.age_min) return false;
  if (r.age_max !== null && p.age > r.age_max) return false;
  return true;
}

/** :gender NULL = '선택 안 함' → 성별 조건 프로그램도 포함한다 (§5 입력 필드 정의) */
function passGender(r: EligibilityRules, p: Profile): boolean {
  if (r.gender === null) return true;
  if (p.gender === null) return true;
  return r.gender === p.gender;
}

/** e.regions && :region_prefixes — 원소 동등 비교이므로 자리수 체계가 같아야 매칭된다 */
function passRegion(r: EligibilityRules, p: Profile): boolean {
  if (r.regions === null || r.regions.length === 0) return true;
  const mine = regionPrefixes(p);
  return r.regions.some((c) => mine.includes(c));
}

function passOccupation(r: EligibilityRules, p: Profile): boolean {
  if (r.occupations === null || r.occupations.length === 0) return true;
  return r.occupations.includes(p.occupation);
}

function passIncome(r: EligibilityRules, p: Profile): boolean {
  if (
    r.income_decile_max !== null &&
    p.incomeDecile !== null &&
    p.incomeDecile > r.income_decile_max
  ) return false;
  if (
    r.median_income_percent_max !== null &&
    p.medianIncomePercent !== null &&
    p.medianIncomePercent > r.median_income_percent_max
  ) return false;
  return true;
}

function incomeUnknown(r: EligibilityRules, p: Profile): boolean {
  return (
    (r.income_decile_max !== null && p.incomeDecile === null) ||
    (r.median_income_percent_max !== null && p.medianIncomePercent === null)
  );
}

function dimensionUnknown(r: EligibilityRules, p: Profile, d: RuleDimension): boolean {
  return (d === "gender" && r.gender !== null && p.gender === null) ||
    (d === "income" && incomeUnknown(r, p));
}

const PREDICATES: Record<
  RuleDimension,
  (r: EligibilityRules, p: Profile) => boolean
> = {
  age: passAge,
  gender: passGender,
  region: passRegion,
  occupation: passOccupation,
  income: passIncome,
};

/** 해당 축에 실제로 조건이 걸려 있는가 (조건_구체성 §7.4 계산의 기준) */
export function isConstrained(r: EligibilityRules, d: RuleDimension): boolean {
  switch (d) {
    case "age":
      return r.age_min !== null || r.age_max !== null;
    case "gender":
      return r.gender !== null;
    case "region":
      return r.regions !== null && r.regions.length > 0;
    case "occupation":
      return r.occupations !== null && r.occupations.length > 0;
    case "income":
      return r.income_decile_max !== null || r.median_income_percent_max !== null;
  }
}

export interface EligibilityResult {
  /** 위반 수. 0 = 자격 통과(집합 A), 1 = 근접 탈락(§7.6) */
  violations: number;
  violatedDimensions: RuleDimension[];
  /** 조건이 걸려 있고 내가 통과한 축 — 매칭 근거·조건_구체성의 근거 */
  matchedDimensions: RuleDimension[];
  /** 공고 조건은 있지만 대응하는 사용자 값이 없는 축 */
  unknownDimensions: RuleDimension[];
}

export function evaluate(r: EligibilityRules, p: Profile): EligibilityResult {
  const violated: RuleDimension[] = [];
  const matched: RuleDimension[] = [];
  const unknown: RuleDimension[] = [];
  for (const d of RULE_DIMENSIONS) {
    const ok = PREDICATES[d](r, p);
    if (!ok) violated.push(d);
    else if (isConstrained(r, d)) {
      if (dimensionUnknown(r, p, d)) unknown.push(d);
      else matched.push(d);
    }
  }
  return {
    violations: violated.length,
    violatedDimensions: violated,
    matchedDimensions: matched,
    unknownDimensions: unknown,
  };
}

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** 주어진 시각의 KST 달력 날짜 (YYYY-MM-DD) */
export function kstDate(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * `programs.starts_at` / `ends_at` 를 **날짜 문자열로** 정규화한다 (SPEC §5).
 *
 * 두 컬럼은 Postgres `date` 타입이다 — 시각이 없는 달력 날짜이고, 공고문의
 * "2026년 8월 14일까지"를 그대로 담는다. 그런데 이 값을 `new Date(...).toISOString()`
 * 으로 전체 타임스탬프(`2026-08-14T00:00:00.000Z`)로 바꾸면 **UTC 자정**이라는
 * 있지도 않은 시각이 생기고, KST 로 읽으면 그날 09:00 이 된다.
 *
 * 그 결과가 하루 밀림이다. 같은 공고를 KST 01:00 에 보면 D-2, 20:00 에 보면 D-1 로
 * 나온다 — 사용자마다·시각마다 결과가 달라지는 비일관성이고, SQL 필터
 * (`ends_at >= (now() AT TIME ZONE 'Asia/Seoul')::date`) 와도 어긋난다.
 *
 * 그래서 DB 경계에서 날짜만 남긴다. 이러면 `isOpen`·`dDay` 의 DATE_ONLY 경로가 항상
 * 타고, 마감일은 그 날짜의 KST 23:59:59 까지 유효한 것으로 일관되게 취급된다.
 */
export function toDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    // 'YYYY-MM-DD' 와 'YYYY-MM-DDTHH:mm:ss...' 모두 앞 10자가 달력 날짜다
    return DATE_ONLY.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
  }
  if (value instanceof Date) {
    // postgres.js 는 date 컬럼을 UTC 자정 Date 로 파싱하므로 UTC 성분을 읽는다.
    // 로컬 성분을 읽으면 서버 타임존에 따라 하루가 밀린다.
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return null;
}

/** 기간 조건 — status='active'이고 KST 기준 접수 시작일부터 마감일까지 */
export function isOpen(prog: Program, now = new Date()): boolean {
  if (prog.status !== "active") return false;
  const today = kstDate(now);
  if (prog.starts_at) {
    if (DATE_ONLY.test(prog.starts_at)) {
      if (prog.starts_at > today) return false;
    } else if (new Date(prog.starts_at).getTime() > now.getTime()) {
      return false;
    }
  }
  if (!prog.ends_at) return true;
  if (DATE_ONLY.test(prog.ends_at)) return prog.ends_at >= today;
  return new Date(prog.ends_at).getTime() >= now.getTime();
}

/** 마감 D-n. 상시/무기한이면 null */
export function dDay(prog: Program, now = new Date()): number | null {
  if (prog.is_always_open || !prog.ends_at) return null;
  if (DATE_ONLY.test(prog.ends_at)) {
    return (Date.parse(`${prog.ends_at}T00:00:00Z`) - Date.parse(`${kstDate(now)}T00:00:00Z`)) /
      86_400_000;
  }
  const end = new Date(prog.ends_at);
  const ms = end.getTime() - now.getTime();
  return Math.ceil(ms / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* §7.5 카드별 매칭 근거 문장 — 외부 호출 없이 템플릿으로 조립한다.       */
/* ------------------------------------------------------------------ */

/** 축별 배지 문구 ("만 28세", "서울 관악구 거주", "3분위") */
export function dimensionBadge(
  d: RuleDimension,
  r: EligibilityRules,
  p: Profile,
): string {
  switch (d) {
    case "age":
      return `만 ${p.age}세`;
    case "gender":
      return p.gender === "F" ? "여성" : p.gender === "M" ? "남성" : "성별 조건";
    case "region": {
      // 기초(5자리)로 걸렸으면 시군구까지, 광역(2자리)이면 시도만
      const mine = regionPrefixes(p);
      const hit = (r.regions ?? []).find((c) => mine.includes(c));
      if (hit && hit.length === 5) {
        return `${shortSido(p.sidoCode)} ${sigunguName(p.sigunguCode)} 거주`;
      }
      return `${shortSido(p.sidoCode)} 거주`;
    }
    case "occupation":
      return occupationName(p.occupation);
    case "income":
      return [
        r.income_decile_max !== null && p.incomeDecile !== null
          ? decileLabel(p.incomeDecile)
          : null,
        r.median_income_percent_max !== null && p.medianIncomePercent !== null
          ? `기준중위소득 ${p.medianIncomePercent}%`
          : null,
      ].filter(Boolean).join(" · ");
  }
}

/**
 * "만 28세 · 서울 거주 · 3분위 조건에 해당합니다"
 * 매칭에 관여한 축이 하나도 없으면(= 전 국민 대상 프로그램) 그 사실을 그대로 말한다.
 */
export function buildReason(
  matched: RuleDimension[],
  r: EligibilityRules,
  p: Profile,
  unknown: RuleDimension[] = [],
): string {
  const pending = unknown.length
    ? `${unknown.map((dimension) => DIMENSION_LABEL[dimension]).join("·")} 조건은 추가 확인이 필요합니다`
    : null;
  if (matched.length === 0) {
    return pending ?? "별도 자격 제한이 없어 누구나 신청할 수 있습니다";
  }
  const parts = matched.map((d) => dimensionBadge(d, r, p));
  return `${parts.join(" · ")} 조건에 해당합니다${pending ? ` · ${pending}` : ""}`;
}

export function buildBadges(
  matched: RuleDimension[],
  r: EligibilityRules,
  p: Profile,
  unknown: RuleDimension[] = [],
): string[] {
  const badges = matched.map((d) => dimensionBadge(d, r, p));
  badges.push(...unknown.map((dimension) => `${DIMENSION_LABEL[dimension]} 추가 확인`));
  return badges.length ? badges : ["자격 제한 없음"];
}

/* ------------------------------------------------------------------ */
/* §7.6 근접 탈락 문구                                                  */
/* ------------------------------------------------------------------ */

/** "소득 2분위 이하면 대상입니다 (현재 3분위)" */
export function nearMissMessage(
  d: RuleDimension,
  r: EligibilityRules,
  p: Profile,
): string {
  switch (d) {
    case "income": {
      const messages: string[] = [];
      if (
        r.income_decile_max !== null &&
        p.incomeDecile !== null &&
        p.incomeDecile > r.income_decile_max
      ) {
        messages.push(
          `소득 ${r.income_decile_max}분위 이하면 대상입니다 (현재 ${p.incomeDecile}분위)`,
        );
      }
      if (
        r.median_income_percent_max !== null &&
        p.medianIncomePercent !== null &&
        p.medianIncomePercent > r.median_income_percent_max
      ) {
        messages.push(
          `기준중위소득 ${r.median_income_percent_max}% 이하면 대상입니다 (현재 약 ${p.medianIncomePercent}%)`,
        );
      }
      return messages.join(" · ");
    }
    case "age": {
      // "이상" 뒤에는 조사 '이'가 붙어야 자연스럽다 ("만 65세 이상이면")
      let range: string;
      if (r.age_min !== null && r.age_max !== null)
        range = `만 ${r.age_min}~${r.age_max}세면`;
      else if (r.age_min !== null) range = `만 ${r.age_min}세 이상이면`;
      else range = `만 ${r.age_max}세 이하면`;
      return `${range} 대상입니다 (현재 만 ${p.age}세)`;
    }
    case "region": {
      const names = (r.regions ?? []).slice(0, 3).map(regionCodeName).join(", ");
      const more = (r.regions ?? []).length > 3 ? " 등" : "";
      return `${names}${more} 거주자가 대상입니다 (현재 ${shortSido(p.sidoCode)} ${sigunguName(p.sigunguCode)})`;
    }
    case "occupation": {
      const names = (r.occupations ?? []).slice(0, 3).map(occupationName).join(", ");
      const more = (r.occupations ?? []).length > 3 ? " 등" : "";
      return `${names}${more}이면 대상입니다 (현재 ${occupationName(p.occupation)})`;
    }
    case "gender":
      return `${r.gender === "F" ? "여성" : "남성"}만 대상입니다`;
  }
}

/* ------------------------------------------------------------------ */
/* 상세 화면 자격 체크리스트 (§9 화면 4)                                 */
/* ------------------------------------------------------------------ */

function requirementText(d: RuleDimension, r: EligibilityRules): string {
  switch (d) {
    case "age":
      if (r.age_min !== null && r.age_max !== null)
        return `만 ${r.age_min}세 ~ 만 ${r.age_max}세`;
      if (r.age_min !== null) return `만 ${r.age_min}세 이상`;
      if (r.age_max !== null) return `만 ${r.age_max}세 이하`;
      return "나이 조건 없음";
    case "gender":
      return r.gender === null
        ? "성별 조건 없음"
        : r.gender === "F"
          ? "여성"
          : "남성";
    case "region":
      if (!r.regions || r.regions.length === 0) return "전국";
      return r.regions.map(regionCodeName).join(", ");
    case "occupation":
      if (!r.occupations || r.occupations.length === 0) return "직업 조건 없음";
      return r.occupations.map(occupationName).join(", ");
    case "income":
      return [
        r.income_decile_max === null ? null : `소득 ${r.income_decile_max}분위 이하`,
        r.median_income_percent_max === null
          ? null
          : `기준중위소득 ${r.median_income_percent_max}% 이하`,
      ].filter(Boolean).join(" · ") || "소득 조건 없음";
  }
}

function mineText(d: RuleDimension, p: Profile): string {
  switch (d) {
    case "age":
      return `만 ${p.age}세`;
    case "gender":
      return p.gender === "F" ? "여성" : p.gender === "M" ? "남성" : "선택 안 함";
    case "region":
      return `${shortSido(p.sidoCode)} ${sigunguName(p.sigunguCode)}`;
    case "occupation":
      return occupationName(p.occupation);
    case "income":
      return [
        p.incomeDecile === null ? null : decileLabel(p.incomeDecile),
        p.medianIncomePercent === null ? null : `기준중위소득 약 ${p.medianIncomePercent}%`,
      ].filter(Boolean).join(" · ") || "입력 안 함";
  }
}

export function checklist(r: EligibilityRules, p: Profile): DimensionCheck[] {
  return RULE_DIMENSIONS.map((d) => {
    const unknown = isConstrained(r, d) && dimensionUnknown(r, p, d);
    return {
      dimension: d,
      constrained: isConstrained(r, d),
      pass: PREDICATES[d](r, p),
      unknown,
      requirement: requirementText(d, r),
      mine: mineText(d, p),
    };
  });
}

/** 배너용 "28세 · 서울 관악구 기준" */
export function profileLabel(p: Profile): string {
  return `${p.age}세 · ${shortSido(p.sidoCode)} ${sigunguName(p.sigunguCode)} 기준`;
}
