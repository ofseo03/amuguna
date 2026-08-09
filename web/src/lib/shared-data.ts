/**
 * 팀 공통 계약 데이터 (원본: /shared/*.json — 수정 금지).
 * scripts/copy-shared.mjs 가 dev/build 직전에 src/data/ 로 복사한다.
 */
import regionsJson from "@/data/regions.json";
import occupationsJson from "@/data/occupations.json";
import incomeDecilesJson from "@/data/income_deciles.json";
import midincomeJson from "@/data/midincome_to_decile.json";

export interface Sido {
  code: string;
  name: string;
}
export interface Sigungu {
  code: string;
  name: string;
  sido: string;
}
export interface Occupation {
  code: string;
  name: string;
  synonyms: string[];
}
export interface DecileLabel {
  decile: number;
  label: string;
  monthly_income_hint: string;
}

export const SIDO: Sido[] = regionsJson.sido;
export const SIGUNGU: Sigungu[] = regionsJson.sigungu;
export const OCCUPATIONS: Occupation[] = occupationsJson.categories;
export const DECILES: DecileLabel[] = incomeDecilesJson.deciles;
export const MIDINCOME_TO_DECILE: { max_percent: number | null; decile: number }[] =
  midincomeJson.mapping;

const SIDO_BY_CODE = new Map(SIDO.map((s) => [s.code, s]));
const SIGUNGU_BY_CODE = new Map(SIGUNGU.map((s) => [s.code, s]));
const OCCUPATION_BY_CODE = new Map(OCCUPATIONS.map((o) => [o.code, o]));

/** SPEC §8 보안: 지역코드 화이트리스트 검증 */
export function isValidSido(code: string): boolean {
  return SIDO_BY_CODE.has(code);
}
export function isValidSigungu(code: string, sido?: string): boolean {
  const s = SIGUNGU_BY_CODE.get(code);
  if (!s) return false;
  return sido === undefined || s.sido === sido;
}
export function isValidOccupation(code: string): boolean {
  return OCCUPATION_BY_CODE.has(code);
}

export function sidoName(code: string): string {
  return SIDO_BY_CODE.get(code)?.name ?? code;
}
export function sigunguName(code: string): string {
  return SIGUNGU_BY_CODE.get(code)?.name ?? code;
}
export function occupationName(code: string): string {
  return OCCUPATION_BY_CODE.get(code)?.name ?? code;
}
export function decileLabel(d: number): string {
  return DECILES.find((x) => x.decile === d)?.label ?? `${d}분위`;
}
export function decileHint(d: number): string {
  return DECILES.find((x) => x.decile === d)?.monthly_income_hint ?? "";
}
export function sigunguOf(sido: string): Sigungu[] {
  return SIGUNGU.filter((s) => s.sido === sido);
}

/** 지역 코드(2자리 또는 5자리)를 사람이 읽는 이름으로 */
export function regionCodeName(code: string): string {
  if (code.length === 2) return sidoName(code);
  const sg = SIGUNGU_BY_CODE.get(code);
  if (!sg) return code;
  return `${shortSido(sg.sido)} ${sg.name}`;
}

/**
 * "서울특별시" → "서울" — 배지·배너용 축약.
 *
 * 접미사만 잘라내면 "전라남도" → "전라남" 처럼 실제로 쓰지 않는 말이 나온다.
 * 도 단위는 관용 약칭이 따로 있으므로 코드로 직접 매핑한다.
 */
const SIDO_SHORT: Record<string, string> = {
  "41": "경기",
  "43": "충북",
  "44": "충남",
  "46": "전남",
  "47": "경북",
  "48": "경남",
  "50": "제주",
  "51": "강원",
  "52": "전북",
};

export function shortSido(code: string): string {
  const mapped = SIDO_SHORT[code];
  if (mapped) return mapped;
  return sidoName(code)
    .replace("특별자치시", "")
    .replace("특별자치도", "")
    .replace("특별시", "")
    .replace("광역시", "");
}
