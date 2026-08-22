/**
 * 자격 판정 표시 (SPEC §7.4 — 충족 / 미충족 / 추가 확인 / 조건 없음).
 *
 * 이모지(✅ ❌ ⚠️ ➖)를 쓰지 않는다:
 *  - 스크린리더가 "흰색 확인 표시 버튼" 처럼 엉뚱하게 읽는다. 이 서비스에서 체크리스트는
 *    부가 장식이 아니라 판정 결과 그 자체라 잘못 읽히면 안 된다 (§8).
 *  - 글꼴·OS 마다 모양과 색이 달라져 통제가 안 된다. 흑백 렌더링되는 환경도 있다.
 *  - 크기가 글자에 묶여 있어 정렬이 흔들린다.
 *
 * 뜻은 항상 옆 글자가 전달한다. 뜻을 담은 자리에서는 label 을 켜서
 * 시각장애 사용자도 같은 정보를 얻게 한다.
 */

export type Status = "pass" | "fail" | "unknown" | "none";

const STYLE: Record<Status, { box: string; label: string }> = {
  pass: { box: "bg-ok-soft text-ok", label: "충족" },
  fail: { box: "bg-danger-soft text-danger", label: "미충족" },
  unknown: { box: "bg-warn-soft text-warn", label: "추가 확인 필요" },
  none: { box: "bg-bg-sunken text-ink-3", label: "조건 없음" },
};

const GLYPH: Record<Status, React.ReactNode> = {
  pass: <path d="m5 13 4.5 4.5L19 7" />,
  fail: <path d="M6 6l12 12M18 6 6 18" />,
  unknown: (
    <>
      <path d="M12 7.5v5.5" />
      <path d="M12 16.8v.2" />
    </>
  ),
  none: <path d="M6 12h12" />,
};

export default function StatusMark({
  status,
  /** true 면 스크린리더용 뜻 글자를 함께 낸다 (옆 글자가 뜻을 말해주지 않는 자리) */
  label = false,
  className = "h-6 w-6",
}: {
  status: Status;
  label?: boolean;
  className?: string;
}) {
  const s = STYLE[status];
  return (
    <>
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-full ${s.box} ${className}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={status === "unknown" ? 2.5 : 3}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[55%] w-[55%]"
        >
          {GLYPH[status]}
        </svg>
      </span>
      {label && <span className="sr-only">{s.label}</span>}
    </>
  );
}
