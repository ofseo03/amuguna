import { CheckMark } from "./visual/Icon";

/**
 * 자격(SQL) ∩ 의도(벡터) 교집합 그림 — 랜딩 "되는 것 중에, 필요한 것만" (SPEC §7.3).
 *
 * 이 서비스의 동작 원리 자체라서 글보다 그림이 빠르다.
 *
 * 원 크기는 min(rem, vw) 다. 넓은 화면에서는 rem 대로 — 글자 크기 토글을 올리면 원도
 * 같이 커져 안쪽 라벨이 삐져나오지 않는다. 좁은 화면에서는 vw 상한이 걸려 화면에 맞춰
 * 멈춘다 (특대 글자 + 390px 에서 가로로 넘치던 것을 이렇게 막았다). 상한이 걸리는
 * 구간에서는 라벨만 커지므로 안쪽 글자를 두 줄 이내로 짧게 유지해야 한다 (§8).
 * 교집합 라벨은 컨테이너 정중앙에 놓는다 — 두 원이 대칭이라 겹치는 부분의 중심과 일치한다.
 *
 * 애니메이션은 스크롤이 굴린다 (animation-timeline: view()). 시간이 아니라 스크롤
 * 진행률이 재생 위치라서, 멈추면 멈추고 올리면 되감긴다. 그림이 화면 정중앙에 오는
 * 순간이 끝점이다. 자바스크립트는 한 줄도 필요 없고, 미지원 브라우저는 그냥 정적으로
 * 보인다 — 기본 상태가 "보이는" 상태이기 때문이다.
 *
 * 원의 색면은 ::before 로 깔고 mix-blend-multiply 를 건다. 겹치는 부분이 저절로 진해져야
 * 벤 다이어그램이 벤 다이어그램으로 읽힌다. 글자에까지 블렌드가 걸리면 색이 탁해지므로
 * 색면만 의사요소로 분리하고, 라벨은 relative 로 그 위에 띄운다.
 */

export default function IntersectionDiagram({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div
      className={`tech-grid rounded-lg border border-line bg-bg px-4 py-8 sm:px-8 ${className}`}
    >
      <div
        role="img"
        aria-label="자격 조건과 찾는 의도를 두 개의 겹치는 원으로 나타낸 그림. 두 원이 겹치는 부분이 실제로 받을 수 있으면서 찾던 것이다."
        className="relative mx-auto flex w-fit items-center justify-center"
      >
        <span
          aria-hidden="true"
          className="venn-left relative flex h-[min(10rem,38vw)] w-[min(10rem,38vw)] items-center justify-center rounded-full border border-brand/30 pr-[min(3rem,11vw)] before:absolute before:inset-0 before:rounded-full before:bg-brand/15 before:mix-blend-multiply before:content-[''] sm:h-[min(14rem,26vw)] sm:w-[min(14rem,26vw)] sm:pr-[min(4rem,7vw)]"
        >
          <span className="relative text-center text-sm font-bold text-brand-dark sm:text-base">
            자격
            <span className="block text-sm font-normal text-ink-3">
              내가 대상인가
            </span>
          </span>
        </span>

        <span
          aria-hidden="true"
          className="venn-right relative -ml-[min(3.5rem,13vw)] flex h-[min(10rem,38vw)] w-[min(10rem,38vw)] items-center justify-center rounded-full border border-accent-plum/30 pl-[min(3rem,11vw)] before:absolute before:inset-0 before:rounded-full before:bg-accent-plum/15 before:mix-blend-multiply before:content-[''] sm:-ml-[min(5rem,9vw)] sm:h-[min(14rem,26vw)] sm:w-[min(14rem,26vw)] sm:pl-[min(4rem,7vw)]"
        >
          <span className="relative text-center text-sm font-bold text-accent-plum sm:text-base">
            의도
            <span className="block text-sm font-normal text-ink-3">
              내가 찾는 것인가
            </span>
          </span>
        </span>

        {/* 두 원이 대칭이므로 컨테이너 정중앙 = 겹치는 부분의 중심 */}
        <span
          aria-hidden="true"
          className="venn-pop absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-ok/30 bg-bg px-2.5 py-2 sm:px-3"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok-soft text-ok">
            <CheckMark />
          </span>
          <span className="text-sm font-bold text-ok">내 것</span>
        </span>
      </div>
    </div>
  );
}
