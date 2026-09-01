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
    /*
     * 한 줄에 여섯 칸을 놓으려면 가장 긴 라벨("원하는 것", 58.6px @100%) 기준으로
     * 58.6 x 6 + 간격 4 x 5 = 371.6px = 23.2rem 이 필요하다. 여유를 둬 23.5rem 으로 잡는다.
     * 그 아래로는 3칸 두 줄로 접는다 — 라벨을 접어 칸에 우겨넣는 것보다 낫다.
     *
     * 기준을 rem 으로 쓰는 게 요점이다. 컨테이너 쿼리의 rem 은 루트 배율,
     * 즉 사용자가 화면 크기 슬라이더로 키운 값을 그대로 따라간다(직접 확인).
     * 그래서 폭이 좁아서든 글자를 키워서든 "안 들어가면 접는다" 가 한 줄로 표현된다.
     * 뷰포트 미디어 쿼리로는 안 된다. 거기서 rem 은 배율을 따라가지 않는다.
     */
    <div className="@container">
      <ol
        aria-label="입력 단계"
        className="grid grid-cols-3 items-start gap-x-1 gap-y-4 @min-[23.5rem]:grid-cols-6"
      >
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const current = n === step;

          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className="flex min-w-0 flex-col items-center gap-1.5"
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
              {/*
                w-full 이 없으면 줄바꿈을 걸 곳이 없어 라벨이 제 칸을 넘어 옆 단계와 겹친다.
                말줄임이 아니라 줄바꿈이다 — 고령층에게 "원하는…" 은 읽히지 않는다.
                body 의 word-break: keep-all 덕에 "원하는" 이 음절 사이에서 갈라지지 않는다.
              */}
              <span
                className={`w-full text-center text-sm leading-tight ${
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
