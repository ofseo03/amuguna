import { CheckMark } from "./visual/Icon";

/**
 * 온보딩 진행 표시 (SPEC §9 화면 2).
 *
 * 막대 하나로는 "몇 개 남았는지"만 알 수 있고 "뭘 더 물어보는지"는 모른다.
 * 남은 질문이 나이·지역 같은 가벼운 것뿐임을 미리 보여주면 중간 이탈이 줄어든다.
 *
 * 아이콘이 아니라 숫자를 쓴다 — 성별·직업 같은 항목은 그림으로 옮기면 뜻이 좁아지거나
 * 특정 이미지를 덧씌우게 된다. 숫자는 그런 문제가 없고 순서도 그대로 읽힌다.
 *
 * 접근성: 단계 목록 자체를 ol 로 두고 현재 단계에 aria-current="step" 을 준다.
 * 아래 막대는 같은 정보의 중복이므로 장식으로 내린다 (§8).
 */

/** 단계 이름이자 개수의 단일 출처. 온보딩의 TOTAL_STEPS 는 이 길이를 쓴다. */
export const STEP_LABELS = ["나이", "성별", "직업", "지역", "소득", "원하는 것"] as const;

export default function StepTrail({ step }: { step: number }) {
  const total = STEP_LABELS.length;
  return (
    <div>
      <ol
        aria-label="입력 단계"
        className="flex items-start justify-between gap-1"
      >
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const current = n === step;

          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors ${
                  done
                    ? "bg-ok-soft text-ok"
                    : current
                      ? "bg-brand text-white"
                      : "border border-line bg-bg text-ink-3"
                }`}
              >
                {done ? (
                  <>
                    <CheckMark className="h-3.5 w-3.5" />
                    <span className="sr-only">완료</span>
                  </>
                ) : (
                  n
                )}
              </span>
              <span
                className={`truncate text-center text-sm ${
                  current ? "font-bold text-brand" : "text-ink-3"
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* 위 목록과 같은 정보라 장식으로 둔다 */}
      <div
        aria-hidden="true"
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-sunken"
      >
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${(step / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
