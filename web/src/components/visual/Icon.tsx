import type { IconName } from "./accents";

/**
 * 삽화용 아이콘 한 벌.
 *
 * 전부 stroke 기반 24x24 로 통일한다 — 두께가 같아야 여러 화면에 흩어져도 한 벌로 보인다.
 * 아이콘은 언제나 장식이다 (aria-hidden). 뜻은 옆에 붙는 글자가 전달한다 (§8).
 */

const PATHS: Record<IconName, React.ReactNode> = {
  megaphone: (
    <>
      <path d="M4 9.5h3.2L14 5.5v13l-6.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      <path d="M17.5 9a4 4 0 0 1 0 6" />
      <path d="M7.5 14.5 9 20" />
    </>
  ),
  bank: (
    <>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5.5 10v8M10 10v8m4 0v-8m4.5 0v8" />
      <path d="M3 20h18" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-1.7L12 21l-3-1.7L6 21V3Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
    </>
  ),
  gavel: (
    <>
      <path d="m13.5 3.5 5 5-2.5 2.5-5-5z" />
      <path d="m12.2 7.8-6.7 6.7" />
      <path d="M4 21h9" />
      <path d="m7 17.5 2.5-2.5" />
    </>
  ),
  /** 흩어진 출처 — 서로 이어지지 않은 창 네 개 */
  scatter: (
    <>
      <rect x="3" y="3.5" width="7" height="6" rx="1.2" />
      <rect x="14" y="5.5" width="7" height="6" rx="1.2" />
      <rect x="3.5" y="14" width="7" height="6" rx="1.2" />
      <rect x="14.5" y="16" width="6" height="4.5" rx="1.2" />
    </>
  ),
  /** 조합형 자격 — 여러 조건이 하나로 좁혀지는 깔때기 */
  funnel: (
    <>
      <path d="M3.5 4.5h17l-6.5 7.5v7l-4 2v-9L3.5 4.5Z" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="7.5" r="3.2" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  external: (
    <>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="m19.5 4.5-8 8" />
      <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
};

/** rem 기반이라 글자 크기 토글을 따라 함께 커진다 (§8). */
const SIZE = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
  xl: "h-7 w-7",
} as const;

export default function Icon({
  name,
  size = "md",
  className,
}: {
  name: IconName;
  size?: keyof typeof SIZE;
  /** 크기를 직접 박아야 하는 자리용 — 글자 크기 조절 슬라이더처럼 rem 을 쓰면 안 되는 곳 */
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? SIZE[size]}
    >
      {PATHS[name]}
    </svg>
  );
}

export function CheckMark({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m5 13 4.5 4.5L19 7" />
    </svg>
  );
}

export function CrossMark({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
