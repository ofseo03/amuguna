/**
 * 서버 측 입력 검증 (SPEC §8 보안).
 * 나이 0~120 / 지역코드 화이트리스트 / 소득분위 1~10 / 기준중위소득 비율 0~10000.
 * 클라이언트 검증은 UX 용일 뿐이고, 신뢰 경계는 여기다.
 */
import { isValidOccupation, isValidSido, isValidSigungu } from "./shared-data";
import type { Gender, MatchCursor, Profile, ProgramForm } from "./types";
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

  const incomeDecile = input.incomeDecile == null ? null : Number(input.incomeDecile);
  if (incomeDecile !== null && (!Number.isInteger(incomeDecile) || incomeDecile < 1 || incomeDecile > 10)) {
    errors.push({ field: "incomeDecile", message: "소득분위는 1에서 10 사이여야 합니다." });
  }

  const medianIncomePercent =
    input.medianIncomePercent == null ? null : Number(input.medianIncomePercent);
  if (
    medianIncomePercent !== null &&
    (!Number.isInteger(medianIncomePercent) || medianIncomePercent < 0 || medianIncomePercent > 10000)
  ) {
    errors.push({
      field: "medianIncomePercent",
      message: "기준중위소득 비율은 0에서 10000 사이여야 합니다.",
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { age, gender, occupation, sidoCode, sigunguCode, incomeDecile, medianIncomePercent },
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

export function validateCursor(input: unknown): Validated<MatchCursor | null> {
  if (input === undefined || input === null || input === "") return { ok: true, value: null };
  if (typeof input !== "string" || input.length > 256 || !/^[A-Za-z0-9_-]+$/.test(input)) {
    return { ok: false, errors: [{ field: "cursor", message: "cursor 값이 올바르지 않습니다." }] };
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(parsed, "score") ||
      !Object.prototype.hasOwnProperty.call(parsed, "id")
    ) {
      throw new Error("invalid cursor shape");
    }
    const { score, id } = parsed as MatchCursor;
    if (!Number.isFinite(score) || score < 0 || score > 1 || !Number.isSafeInteger(id) || id < 1) {
      throw new Error("invalid cursor values");
    }
    return { ok: true, value: { score, id } };
  } catch {
    return { ok: false, errors: [{ field: "cursor", message: "cursor 값이 올바르지 않습니다." }] };
  }
}
