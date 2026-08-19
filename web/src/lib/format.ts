/** 표시용 포매터. 숫자 필드는 항상 DB 값을 그대로 렌더한다 (§7.5). */

/**
 * 날짜 원시값 — 이 모듈이 의존이 없는 leaf 라서 여기에 둔다.
 * `eligibility.ts` 가 가져다 쓴다. 반대로 하면 format 을 쓰는 클라이언트 컴포넌트에
 * eligibility·shared-data·JSON 이 통째로 딸려온다.
 */
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/**
 * 날짜 표기 — 전 경로 KST 고정 (SPEC §5).
 *
 * `starts_at`·`ends_at` 은 시각이 없는 달력 날짜이므로 **문자열을 그대로 쪼갠다.**
 * `new Date("2026-08-14")` 는 UTC 자정으로 파싱되므로, 로컬 성분(`getDate()`)으로 읽으면
 * UTC 서쪽 브라우저에서 하루 앞 날짜가 찍힌다.
 *
 * 시각이 붙은 값(`fetched_at`)은 KST 로 환산해 표기한다 — 서버는 UTC, 사용자는 KST 라
 * 로컬 성분을 그대로 쓰면 서버 렌더와 클라이언트 렌더가 어긋난다.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  if (DATE_ONLY.test(iso)) {
    const [y, m, d] = iso.split("-");
    return `${Number(y)}. ${Number(m)}. ${Number(d)}.`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}. ${kst.getUTCMonth() + 1}. ${kst.getUTCDate()}.`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)} ${hh}:${mm}`;
}

/** D-n 배지 문구. null = 상시 */
export function dDayLabel(d: number | null): string {
  if (d === null) return "상시";
  if (d < 0) return "마감";
  if (d === 0) return "오늘 마감";
  return `D-${d}`;
}

/** D-7 이내면 강조 */
export function isUrgent(d: number | null): boolean {
  return d !== null && d >= 0 && d <= 7;
}

const LEVEL_LABEL: Record<string, string> = {
  central: "정부·중앙기관",
  metro: "광역자치단체",
  local: "기초자치단체",
};

export function issuerLevelLabel(level: string): string {
  return LEVEL_LABEL[level] ?? level;
}

/** 수집 원문에 포함된 링크를 렌더하기 전 http(s)만 허용한다. */
export function externalHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
