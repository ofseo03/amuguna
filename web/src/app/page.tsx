import HeroVisual from "@/components/HeroVisual";
import IntersectionDiagram from "@/components/IntersectionDiagram";
import ResultPreview from "@/components/ResultPreview";
import Icon from "@/components/visual/Icon";
import type { IconName } from "@/components/visual/accents";
import Tile, { TileHead } from "@/components/ui/Tile";
import { ActionLink } from "@/components/ui/ActionButton";
import { isDbConfigured } from "@/lib/db";

// 데모 모드 배너가 배포 환경의 실제 환경변수를 반영해야 하므로 요청 시 렌더한다.
// (빌드 시점에 정적으로 굳으면 DATABASE_URL 을 나중에 넣어도 계속 "데모 모드"라고 표시된다)
export const dynamic = "force-dynamic";

/**
 * 랜딩 (SPEC §9 화면 1).
 *
 * 전면 타일을 밝은 면 ↔ 어두운 면으로 번갈아 쌓는다. 타일 사이에 테두리도 여백도 없고,
 * 색이 바뀌는 것 자체가 구분선이다. 각 타일은 헤드라인 → 한 줄 → CTA → 삽화 순서로만 짠다.
 *
 * 삽화는 이 서비스의 "제품 사진" 역할이다. 어두운 타일 위에서도 삽화 자체는 밝은 채로
 * 둔다 — 검은 배경 위에 놓인 흰 제품처럼. 그래서 어두운 면에서만 제품 그림자를 준다.
 */
export default function LandingPage() {
  const demo = !isDbConfigured();

  return (
    <>
      {/* ---------------------------------------- 1. 히어로 (밝은 면) */}
      <Tile tone="canvas" innerClassName="pt-16 sm:pt-24">
        <div className="flex flex-col items-center text-center">
          <h1 className="t-hero">
            내게 맞는 금융정보,{" "}
            <span className="text-brand">1분이면 찾습니다.</span>
          </h1>
          <p className="t-lead mt-5 text-ink-2">
            나이·지역·소득만 고르면, 실제로 대상이 되는 금융정보를 보여드립니다.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <ActionLink href="/onboarding">1분 만에 확인하기</ActionLink>
            <ActionLink href="/sources" variant="pill-ghost">
              데이터 출처 보기
            </ActionLink>
          </div>
          <p className="mt-5 text-sm text-ink-3">
            이름·연락처·주민번호를 묻지 않습니다.
          </p>

          {demo && (
            <p className="mt-8 max-w-[60ch] rounded-lg border border-warn bg-warn-soft px-5 py-4 text-left text-sm text-ink-2">
              <strong className="text-warn">데모 모드</strong> — 데이터베이스가
              연결되지 않아 번들 예시 데이터 22건으로 동작 중입니다. 매칭·스코어링·
              근접탈락 로직은 실제와 동일합니다.
            </p>
          )}
        </div>

        <div className="mt-14">
          <HeroVisual className="shadow-product" />
        </div>
      </Tile>

      {/* ------------------------------- 2. 문제 제기 (어두운 면) */}
      <Tile tone="dark">
        <TileHead
          headline="여기저기 흩어진 걸 하나로"
          tagline="어디를 봐야 할지 몰라서 못 받는 일이 없도록."
        />
        <ul className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
          <Reason
            icon="scatter"
            title="모으고"
            body="부처와 지자체, 공공기관이 각자 올리는 공고를 모아 옵니다."
          />
          <Reason
            icon="funnel"
            title="정리하고"
            body="자격요건과 기간, 내용을 정리합니다."
          />
          <Reason
            icon="receipt"
            title="보여주고"
            body="조건과 필요에 맞는 것을 보여줍니다."
          />
        </ul>
      </Tile>

      {/* ------------------------------ 3. 동작 원리 (parchment) */}
      <Tile tone="parchment">
        <TileHead
          headline="되는 것 중에, 필요한 것만"
          tagline="조건이 안 맞는 걸 붙들고 시간 쓰는 일이 없도록."
        />
        <div className="mt-14">
          <IntersectionDiagram />
        </div>
      </Tile>

      {/* ----------------------------- 4. 결과물 (어두운 면) */}
      <Tile tone="dark-2">
        <TileHead
          headline="근거까지 카드 한 장에"
          tagline="왜 나왔는지 몰라서 다시 찾아보는 일이 없도록."
        />
        <div className="mt-14">
          <ResultPreview className="shadow-product" />
        </div>
      </Tile>

      {/* --------------------------------- 5. 마무리 (parchment) */}
      <Tile tone="parchment" innerClassName="text-center">
        <h2 className="t-display">이제 찾아볼 차례</h2>
        <p className="t-lead mt-4 text-ink-2">
          1분이면 끝납니다. 이름도 연락처도 묻지 않습니다.
        </p>
        <div className="mt-8 flex justify-center">
          <ActionLink href="/onboarding">1분 만에 확인하기</ActionLink>
        </div>
      </Tile>
    </>
  );
}

/** 어두운 타일 위의 이유 카드 — 테두리 없이 아이콘·제목·본문만 */
function Reason({
  icon,
  title,
  body,
}: {
  icon: IconName;
  title: string;
  body: string;
}) {
  return (
    <li>
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/10 text-on-dark">
          <Icon name={icon} size="lg" />
        </span>
        <h3 className="t-tagline">{title}</h3>
      </div>
      <p className="mt-4 text-on-dark-muted">{body}</p>
    </li>
  );
}
