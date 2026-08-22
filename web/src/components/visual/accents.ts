/**
 * 화면 전반의 삽화·아이콘이 쓰는 색 조합.
 *
 * 여기 한 곳에서만 색을 정한다 — 배지·아이콘 타일·체크 표시가 같은 계열을 쓰게 하려고.
 * 값은 globals.css 의 토큰을 가리키고, 토큰은 모두 흰 배경 대비 4.5:1 이상이라
 * 작은 글자나 체크 표시에 그대로 써도 된다 (§8).
 *
 * 색만으로 뜻을 전달하지 않는다 — 이 색을 쓰는 자리에는 항상 라벨이나 아이콘이 함께 붙는다.
 */

export type Accent = "blue" | "teal" | "green" | "violet" | "plum";

export const ACCENT: Record<
  Accent,
  { tile: string; icon: string; check: string; /** SVG stroke/fill 용 원시 색 */ raw: string }
> = {
  blue: {
    tile: "bg-brand-soft",
    icon: "text-brand",
    check: "bg-brand-soft text-brand",
    raw: "var(--brand)",
  },
  teal: {
    tile: "bg-accent-teal-soft",
    icon: "text-accent-teal",
    check: "bg-accent-teal-soft text-accent-teal",
    raw: "var(--accent-teal)",
  },
  green: {
    tile: "bg-ok-soft",
    icon: "text-ok",
    check: "bg-ok-soft text-ok",
    raw: "var(--ok)",
  },
  violet: {
    tile: "bg-accent-violet-soft",
    icon: "text-accent-violet",
    check: "bg-accent-violet-soft text-accent-violet",
    raw: "var(--accent-violet)",
  },
  plum: {
    tile: "bg-accent-plum-soft",
    icon: "text-accent-plum",
    check: "bg-accent-plum-soft text-accent-plum",
    raw: "var(--accent-plum)",
  },
};

/**
 * 정보 카테고리 5종. 히어로 배지·리포트 행·결과 미리보기가 모두 이 목록을 쓴다.
 *
 * example 문구는 실제 공고를 흉내낸 예시이되 특정 금융회사 상품명은 쓰지 않는다 —
 * 상품명이 박히면 비교·안내가 아니라 권유·광고로 읽힐 여지가 생긴다
 * (SiteChrome 의 금융소비자보호법 고지와 같은 이유).
 */
export const CATEGORIES: {
  label: string;
  icon: IconName;
  accent: Accent;
  example: string;
}[] = [
  { label: "지원금", icon: "megaphone", accent: "blue", example: "청년 일자리 도약장려금" },
  { label: "대출", icon: "bank", accent: "teal", example: "버팀목 전세자금대출 한도" },
  { label: "세금", icon: "receipt", accent: "green", example: "연말정산 환급 대상 공제" },
  { label: "금융상품", icon: "link", accent: "violet", example: "ISA 비과세 한도 비교" },
  { label: "법령", icon: "gavel", accent: "plum", example: "청년 주거지원 개정 사항" },
];

export type IconName =
  | "megaphone"
  | "bank"
  | "receipt"
  | "link"
  | "gavel"
  | "scatter"
  | "funnel"
  | "person"
  | "search"
  | "clock"
  | "external";
