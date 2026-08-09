/**
 * 서버 측 입력 검증 (SPEC §8 보안).
 * 나이 0~120 / 지역코드 화이트리스트 / 소득분위 1~10 / 자유입력 200자.
 * 클라이언트 검증은 UX 용일 뿐이고, 신뢰 경계는 여기다.
 */
import { isValidOccupation, isValidSido, isValidSigungu } from "./shared-data";
import type { Gender, Profile, ProgramForm } from "./types";
import { FORMS } from "./forms";

export const MAX_QUERY_LEN = 200;

export interface ValidationError {
  field: string;
  message: string;
}

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function validateProfile(input: any): Validated<Profile> {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: [{ field: "body", message: "요청 본문이 올바르지 않습니다." }] };
  }

  const age = Number(input.age);
  if (!Number.isInteger(age) || age < 0 || age > 120) {
    errors.push({ field: "age", message: "나이는 0에서 120 사이의 정수여야 합니다." });
  }

  let gender: Gender = null;
  if (input.gender === "M" || input.gender === "F") gender = input.gender;
  else if (input.gender !== null && input.gender !== undefined && input.gender !== "") {
    errors.push({ field: "gender", message: "성별 값이 올바르지 않습니다." });
  }

  const occupation = String(input.occupation ?? "");
  if (!isValidOccupation(occupation)) {
    errors.push({ field: "occupation", message: "직업 분류 코드가 올바르지 않습니다." });
  }

  const sidoCode = String(input.sidoCode ?? "");
  if (!isValidSido(sidoCode)) {
    errors.push({ field: "sidoCode", message: "시·도 코드가 올바르지 않습니다." });
  }

  const sigunguCode = String(input.sigunguCode ?? "");
  if (!isValidSigungu(sigunguCode, isValidSido(sidoCode) ? sidoCode : undefined)) {
    errors.push({ field: "sigunguCode", message: "시·군·구 코드가 올바르지 않습니다." });
  }

  const incomeDecile = Number(input.incomeDecile);
  if (!Number.isInteger(incomeDecile) || incomeDecile < 1 || incomeDecile > 10) {
    errors.push({ field: "incomeDecile", message: "소득분위는 1에서 10 사이여야 합니다." });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { age, gender, occupation, sidoCode, sigunguCode, incomeDecile },
  };
}

/** 자유입력 — 200자 초과는 거절한다 (조용히 자르지 않는다: 사용자가 무엇이 검색됐는지 알아야 한다) */
export function validateQuery(input: unknown): Validated<string | null> {
  if (input === null || input === undefined || input === "") return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, errors: [{ field: "query", message: "검색어 형식이 올바르지 않습니다." }] };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if ([...trimmed].length > MAX_QUERY_LEN) {
    return {
      ok: false,
      errors: [{ field: "query", message: `입력은 ${MAX_QUERY_LEN}자를 넘을 수 없습니다.` }],
    };
  }
  return { ok: true, value: trimmed };
}

export function validateForm(input: unknown): ProgramForm | "all" {
  if (typeof input === "string" && (FORMS as string[]).includes(input)) {
    return input as ProgramForm;
  }
  return "all";
}

export function validatePage(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10_000);
}

/** 알림 신청 이메일 — 과하게 엄격하지 않게, 명백한 오입력만 거른다 */
export function validateEmail(input: unknown): Validated<string> {
  const s = String(input ?? "").trim();
  if (s.length === 0) {
    return { ok: false, errors: [{ field: "email", message: "이메일을 입력해 주세요." }] };
  }
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
    return { ok: false, errors: [{ field: "email", message: "이메일 형식이 올바르지 않습니다." }] };
  }
  return { ok: true, value: s.toLowerCase() };
}
