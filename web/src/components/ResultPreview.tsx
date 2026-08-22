import Icon, { CheckMark, CrossMark } from "./visual/Icon";

/**
 * 결과 카드 미리보기 — 랜딩 "이렇게 알려드립니다" (SPEC §9 화면 3·4).
 *
 * 실제 ProgramCard / NearMissItem 의 구조와 색을 그대로 흉내낸다.
 * 랜딩에서 본 모양이 결과 화면에서 그대로 나와야 "설명"이 아니라 "미리보기"가 된다.
 *
 * 링크처럼 보이는 요소는 실제 링크가 아니므로 전체를 aria-hidden 으로 덮고
 * 바깥 컨테이너의 role=img 설명으로 갈음한다 — 스크린리더가 누를 수 없는 가짜 링크를
 * 읽어주면 그게 더 나쁘다 (§8).
 */

const CHECKLIST = [
  { ok: true, label: "만 19~34세", value: "만 28세" },
  { ok: true, label: "서울 거주", value: "서울 마포구" },
  { ok: true, label: "중위소득 150% 이하", value: "3분위" },
  { ok: false, label: "무주택 세대주", value: "확인 필요" },
];

export default function ResultPreview() {
  return (
    <div
      role="img"
      aria-label="결과 카드 예시. 카드에 매칭 근거 문장과 조건 배지가 붙고, 상세 화면에는 항목별 자격 체크리스트가 표시되며, 조건이 하나만 어긋난 지원은 따로 안내되고, 모든 카드에 원문 링크와 수집 시각이 함께 표시된다."
      className="rounded-2xl border border-line-soft bg-gradient-to-br from-bg-soft via-white to-ok-soft/40 px-4 py-8 sm:px-8"
    >
      <div aria-hidden="true" className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-2">
        <MatchCard />
        <div className="flex flex-col gap-4">
          <Checklist />
          <NearMiss />
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-ink-3">
        <span className="font-semibold text-ink-2">예시 화면입니다.</span> 실제
        카드는 입력한 조건에 따라 달라집니다.
      </p>
    </div>
  );
}

/** 매칭 근거가 붙은 결과 카드 */
function MatchCard() {
  return (
    <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-bg-sunken px-2 py-0.5 font-semibold text-ink-2">
          지원금
        </span>
        <span className="text-ink-3">중앙부처</span>
        <span className="text-line">·</span>
        <span className="text-ink-3">고용노동부</span>
        <span className="ml-auto rounded bg-bg-sunken px-2 py-0.5 font-bold text-ink-2">
          마감 D-24
        </span>
      </div>

      <p className="text-lg font-bold leading-snug text-ink">
        청년 일자리 도약장려금
      </p>
      <p className="mt-1 text-ink-2">
        중소기업에 정규직으로 취업한 청년에게 지급하는 장려금입니다.
      </p>
      <p className="mt-3 text-lg font-bold text-brand-dark">최대 월 60만원</p>

      <div className="mt-4 border-t border-line-soft pt-3">
        <p className="mb-2 text-sm text-ink-2">
          <span className="font-semibold text-ok">매칭 근거</span> · 만 28세 ·
          서울 거주 · 3분위 조건에 해당합니다
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {["만 28세", "서울 거주", "소득 3분위"].map((b) => (
            <li
              key={b}
              className="rounded-full bg-ok-soft px-2.5 py-0.5 text-sm font-medium text-ok"
            >
              {b}
            </li>
          ))}
        </ul>
      </div>

      {/* 원문 링크 · 수집 시각 */}
      <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft pt-3 text-sm text-ink-3">
        <span className="flex items-center gap-1.5 font-semibold text-brand">
          <Icon name="external" size="sm" />
          공고 원문
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="clock" size="sm" />2시간 전 수집
        </span>
      </p>
    </div>
  );
}

/** 상세 화면의 자격 체크리스트 */
function Checklist() {
  return (
    <div className="rounded-xl border border-line bg-white p-5 shadow-sm">
      <p className="font-bold text-ink">자격 체크리스트</p>
      <ul className="mt-3 flex flex-col gap-2">
        {CHECKLIST.map((c) => (
          <li key={c.label} className="flex items-center gap-2.5 text-sm">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                c.ok ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"
              }`}
            >
              {c.ok ? <CheckMark /> : <CrossMark />}
            </span>
            <span className="text-ink-2">{c.label}</span>
            <span className="ml-auto font-semibold text-ink-3">{c.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 조건이 하나만 어긋난 근접 탈락 안내 */
function NearMiss() {
  return (
    <div className="rounded-xl border border-warn bg-warn-soft p-4">
      <p className="text-sm font-semibold text-ink-3">조건이 하나만 어긋남</p>
      <p className="mt-1 font-bold text-ink">청년 월세 한시 특별지원</p>
      <p className="mt-1.5 font-semibold text-warn">
        소득 2분위 이하면 대상입니다
      </p>
    </div>
  );
}
