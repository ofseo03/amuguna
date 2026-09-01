import { ACCENT, CATEGORIES } from "./visual/accents";
import Icon, { CheckMark } from "./visual/Icon";

/**
 * 랜딩 첫 화면 히어로 비주얼 (SPEC §9 화면 1).
 *
 * 시안(흩어진 출처 → 내 맞춤 리포트 → 법적 고지/보안)을 이미지가 아니라 마크업으로 짰다.
 * 래스터 이미지로 넣지 않은 이유:
 *  - 카드 안의 글자가 진짜 텍스트라야 화면 크기 슬라이더(--screen-zoom)를 따라 커진다.
 *    고령층 대상 서비스에서 히어로만 글자가 안 커지면 그 화면부터 이탈한다 (§8).
 *  - 스크린리더가 읽고, 브라우저 번역·검색·복사가 되고, 색 대비를 토큰으로 보장할 수 있다.
 *  - 고해상도 대응(2x/3x)이나 다크모드 대체 이미지가 필요 없다.
 *
 * 장식(리본·후광·방패)만 aria-hidden 인 인라인 SVG 다.
 */

/** 배지 열을 시안처럼 활 모양으로 밀어낸다 (가운데가 가장 왼쪽). */
const ARC_OFFSET = ["14", "5", "0", "5", "14"];

export default function HeroVisual({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-line bg-bg-soft px-4 py-8 sm:px-8 sm:py-12 ${className}`}
      role="img"
      aria-label="흩어져 있는 지원금·대출·세금·금융상품·법령 정보가 하나의 맞춤 리포트로 모이고, 자격 근거와 법적 고지가 함께 표시되는 화면 예시"
    >
      {/* 내부 요소는 위 role=img 의 설명으로 갈음한다 — 스크린리더가 장식 텍스트까지 읽지 않도록 */}
      <div aria-hidden="true" className="relative">
        {/* lg 미만: 출처를 칩으로 가로 배치. lg 이상: 왼쪽 배지 열 + 리본 */}
        <SourceChips />

        <div className="lg:grid lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,12rem)] lg:items-center lg:gap-x-6">
          <SourceBadges />
          <div className="relative">
            <Ribbons />
            <ReportCard />
          </div>
          <TrustStack />
        </div>
      </div>

      <p className="relative mt-6 text-sm text-ink-3 lg:mt-8">
        <span className="font-semibold text-ink-2">예시 화면입니다.</span> 실제
        결과는 입력한 조건에 따라 달라지며, 카드마다 원문 링크와 수집 시각을 함께
        표시합니다.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- 장식 */

/**
 * 배지에서 리포트 카드로 흘러드는 리본. lg 이상에서만 그린다.
 *
 * 배지 열 위로 넘어와도 글자를 덮지 않도록 z-0 에 깔고, 배지·카드는 z-10 으로 올린다.
 */
function Ribbons() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 240 320"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-y-0 -left-52 z-0 hidden h-full w-52 lg:block"
    >
      <defs>
        {/*
         * gradientUnits 를 userSpaceOnUse 로 둔다 (기본값 objectBoundingBox 가 아니라).
         *  - 가운데 리본은 완전한 수평선이라 bbox 높이가 0 이다. objectBoundingBox 는
         *    이때 퇴화(degenerate)해서 스펙상 해당 도형이 아예 그려지지 않는다.
         *  - 겸사겸사 5개 리본의 페이드인 지점이 각자의 bbox 가 아니라 같은 x 에 맞는다.
         */}
        {CATEGORIES.map((c, i) => (
          <linearGradient
            key={c.label}
            id={`ribbon-${i}`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="240"
            y2="0"
          >
            <stop offset="0%" stopColor={ACCENT[c.accent].raw} stopOpacity="0" />
            <stop offset="45%" stopColor={ACCENT[c.accent].raw} stopOpacity="0.3" />
            <stop offset="100%" stopColor={ACCENT[c.accent].raw} stopOpacity="0.42" />
          </linearGradient>
        ))}
      </defs>
      {/*
       * 각 배지 높이(y0)에서 카드 왼쪽 모서리(x=240)로 모여든다.
       * 끝점을 완전히 겹치지 않게 벌려 둔다 — 겹치면 나중에 그린 리본이 앞의 것을 덮어
       * 5개 중 몇 개가 사라진 것처럼 보인다. 카드가 끝을 가리므로 벌어진 티는 안 난다.
       */}
      {[26, 93, 160, 227, 294].map((y0, i) => {
        const yEnd = 160 + (i - 2) * 30;
        return (
          <path
            key={y0}
            d={`M0 ${y0} C ${90 + i * 6} ${y0}, ${120 + i * 5} ${yEnd}, 240 ${yEnd}`}
            fill="none"
            stroke={`url(#ribbon-${i})`}
            strokeWidth="10"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------ 출처 배지 */

function SourceBadges() {
  return (
    <ul className="relative z-10 hidden lg:flex lg:flex-col lg:gap-4">
      {CATEGORIES.map((c, i) => (
        <li
          key={c.label}
          className="flex items-center gap-3"
          style={{ marginLeft: `${ARC_OFFSET[i]}%` }}
        >
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-bg ${ACCENT[c.accent].icon}`}
          >
            <Icon name={c.icon} size="lg" />
          </span>
          <span className="text-base font-bold text-ink">{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** 좁은 화면용 — 배지 열 대신 칩 한 줄로 접는다. */
function SourceChips() {
  return (
    <ul className="mb-6 flex flex-wrap justify-center gap-2 lg:hidden">
      {CATEGORIES.map((c) => (
        <li
          key={c.label}
          className={`flex items-center gap-1.5 rounded-full border border-line-soft bg-bg px-3 py-1.5 text-sm font-semibold ${ACCENT[c.accent].icon}`}
        >
          <Icon name={c.icon} />
          <span className="text-ink">{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------- 리포트 카드 */

function ReportCard() {
  return (
    // lg 에서는 열 왼쪽에 붙인다 — 가운데 정렬하면 리본 끝과 카드 사이가 떠서 흐름이 끊긴다
    <div className="relative z-10 mx-auto max-w-sm rounded-lg border border-line bg-bg p-4 sm:p-5 lg:mx-0">
      <p className="mb-4 flex flex-wrap items-baseline gap-x-2 text-lg font-bold text-ink">
        내 맞춤 리포트
        <span className="text-sm font-normal text-ink-3">조건이 겹치는 것만</span>
      </p>

      <ul className="flex flex-col gap-2.5">
        {CATEGORIES.map((c) => {
          const a = ACCENT[c.accent];
          return (
            <li
              key={c.label}
              className="flex items-center gap-3 rounded-xl border border-line-soft bg-bg-soft px-3 py-2.5"
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${a.tile} ${a.icon}`}
              >
                <Icon name={c.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-ink">{c.label}</span>
                <span className="block truncate text-sm text-ink-3">{c.example}</span>
              </span>
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${a.check}`}
              >
                <CheckMark />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------- 보안 · 법적 고지 스택 */

function TrustStack() {
  return (
    <div className="mt-6 flex items-center justify-center gap-4 lg:mt-0 lg:flex-col lg:items-stretch lg:gap-0">
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand lg:h-20 lg:w-20 lg:translate-y-4 lg:self-center">
        <ShieldLock />
      </span>

      <div className="relative rounded-lg border border-line bg-bg p-3 lg:pt-5">
        <p className="text-sm font-bold text-ink">법적 고지 · 근거</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {["자격 근거 표시", "원문 출처 링크", "권유 아닌 비교 안내"].map((t) => (
            <li key={t} className="flex items-center gap-2 text-sm text-ink-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                <CheckMark />
              </span>
              {t}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ShieldLock() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-8 w-8 lg:h-10 lg:w-10"
    >
      <path d="M12 3 20 6v6c0 4.4-3.2 7.9-8 9-4.8-1.1-8-4.6-8-9V6l8-3Z" />
      <path d="M9.6 11.5V10a2.4 2.4 0 0 1 4.8 0v1.5" />
      <rect x="8.8" y="11.5" width="6.4" height="4.6" rx="1" />
    </svg>
  );
}
