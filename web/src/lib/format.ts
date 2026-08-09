/** 표시용 포매터. 숫자 필드는 항상 DB 값을 그대로 렌더한다 (§7.5). */

export function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
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
