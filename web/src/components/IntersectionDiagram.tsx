import { CheckMark } from "./visual/Icon";

/**
 * 자격(SQL) ∩ 의도(벡터) 교집합 그림 — 랜딩 "두 가지를 동시에 봅니다" (SPEC §7.3).
 *
 * 이 서비스의 동작 원리 자체라서 글보다 그림이 빠르다.
 *
 * 원을 rem 단위(h-40/h-56)로 잡은 게 핵심이다. 글자 크기 토글을 올리면 원도 같이 커져서
 * 안쪽 라벨이 원 밖으로 삐져나오지 않는다. px 로 잡으면 글자만 커져 바로 깨진다 (§8).
 * 교집합 라벨은 컨테이너 정중앙에 놓는다 — 두 원이 대칭이라 겹치는 부분의 중심과 일치한다.
 */

const REGIONS = [
  {
    key: "자격만",
    dot: "bg-brand",
    title: "자격만 맞추면",
    body: "관계없는 정보가 수백 건 쏟아집니다.",
  },
  {
    key: "의도만",
    dot: "bg-accent-violet",
    title: "검색어만 맞추면",
    body: "대상도 아닌 것을 권하게 됩니다.",
  },
  {
    key: "교집합",
    dot: "bg-ok",
    title: "겹치는 곳만",
    body: "받을 수 있으면서 내가 찾던 것.",
  },
];

export default function IntersectionDiagram() {
  return (
    <div className="rounded-2xl border border-line-soft bg-gradient-to-br from-bg-soft via-white to-brand-soft/40 px-4 py-8 sm:px-8">
      <div
        role="img"
        aria-label="자격 조건과 찾는 의도를 두 개의 겹치는 원으로 나타낸 그림. 자격만 맞으면 관계없는 정보가 수백 건 쏟아지고, 검색어만 맞으면 대상이 아닌 것을 권하게 되며, 두 원이 겹치는 부분만 실제로 받을 수 있으면서 찾던 것이다."
        className="relative mx-auto flex w-fit items-center justify-center"
      >
        <span
          aria-hidden="true"
          className="flex h-40 w-40 items-center justify-center rounded-full border border-brand/30 bg-brand/10 pr-12 sm:h-56 sm:w-56 sm:pr-16"
        >
          <span className="text-center text-sm font-bold text-brand-dark sm:text-base">
            자격
            <span className="block text-xs font-normal text-ink-3 sm:text-sm">
              내가 대상인가
            </span>
          </span>
        </span>

        <span
          aria-hidden="true"
          className="-ml-14 flex h-40 w-40 items-center justify-center rounded-full border border-accent-violet/30 bg-accent-violet/10 pl-12 sm:-ml-20 sm:h-56 sm:w-56 sm:pl-16"
        >
          <span className="text-center text-sm font-bold text-accent-violet sm:text-base">
            의도
            <span className="block text-xs font-normal text-ink-3 sm:text-sm">
              내가 찾는 것인가
            </span>
          </span>
        </span>

        {/* 두 원이 대칭이므로 컨테이너 정중앙 = 겹치는 부분의 중심 */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-ok/30 bg-white px-2.5 py-2 shadow-md sm:px-3"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ok-soft text-ok">
            <CheckMark />
          </span>
          <span className="text-sm font-bold text-ok">내 것</span>
        </span>
      </div>

      <ul className="mx-auto mt-8 grid max-w-3xl gap-3 sm:grid-cols-3">
        {REGIONS.map((r) => (
          <li
            key={r.key}
            className="rounded-xl border border-line-soft bg-white p-4"
          >
            <p className="flex items-center gap-2 font-bold text-ink">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.dot}`}
              />
              {r.title}
            </p>
            <p className="mt-1.5 text-sm text-ink-2">{r.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
