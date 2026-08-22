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
          <h1 className="t-hero max-w-[24ch]">
            받을 수 있는데 몰라서 못 받는 돈,
            <br />
            <span className="text-brand">1분이면 찾습니다.</span>
          </h1>
          <p className="t-lead mt-5 max-w-[44ch] text-ink-2">
            나이·지역·소득만 고르면, 흩어져 있는 정부·지자체·공공기관의 지원금과
            대출·금융상품 중에서 내가 실제로 대상이 되는 것만 골라 보여드립니다.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <ActionLink href="/onboarding">1분 만에 확인하기</ActionLink>
            <ActionLink href="/sources" variant="pill-ghost">
              데이터 출처 보기
            </ActionLink>
          </div>
          <p className="mt-5 text-sm text-ink-3">
            회원가입 없음 · 익명 이용 · 이름·연락처·주민번호를 묻지 않습니다.
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
          headline="왜 검색해도 안 나왔을까요?"
          tagline="정보가 없어서가 아닙니다. 찾을 수 있는 모양이 아니어서입니다."
        />
        <ul className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
          <Reason
            n="01"
            icon="scatter"
            title="흩어져 있습니다"
            body="지원 정보는 부처·지자체·공공기관 사이트에 따로 올라옵니다. 어디를 봐야 할지부터 막힙니다."
          />
          <Reason
            n="02"
            icon="funnel"
            title="자격이 조합형입니다"
            body="'만 19~34세, 중위소득 150% 이하, 무주택, 6개월 이상 거주' — 공고문을 끝까지 읽어야 내가 대상인지 압니다."
          />
          <Reason
            n="03"
            icon="person"
            title="필요한 사람일수록 어렵습니다"
            body="고령층·저소득층일수록 찾기 어려운데, 지원이 가장 필요한 것도 그분들입니다."
          />
        </ul>
      </Tile>

      {/* ------------------------------ 3. 동작 원리 (parchment) */}
      <Tile tone="parchment">
        <TileHead
          headline="두 가지를 동시에 봅니다"
          tagline="자격만 맞추면 관계없는 정보가 쏟아지고, 검색어만 맞추면 대상도 아닌 것을 권하게 됩니다."
        />
        <div className="mt-14">
          <IntersectionDiagram />
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <Explain
            title="① 내가 대상인가"
            sub="(자격)"
            body="나이·성별·직업·지역·소득분위 5가지를 공고문에서 뽑아낸 자격요건과 하나씩 대조합니다. 조건이 없는 항목은 통과로 봅니다 — 빠뜨리는 쪽이 더 손해이기 때문입니다."
          />
          <Explain
            title="② 내가 찾는 것인가"
            sub="(의도)"
            body="“보증금 올려달래서 대출 알아봐요” 처럼 한 줄만 적으면 뜻이 가까운 공고를 찾아냅니다. 뭘 찾을지 모르겠다면 건너뛰어도 됩니다."
          />
        </div>
      </Tile>

      {/* ----------------------------- 4. 결과물 (어두운 면) */}
      <Tile tone="dark-2">
        <TileHead
          headline="이렇게 알려드립니다"
          tagline="왜 매칭됐는지, 어떤 조건이 맞고 틀린지, 원문은 어디인지까지 한 카드에."
        />
        <div className="mt-14">
          <ResultPreview className="shadow-product" />
        </div>
      </Tile>

      {/* --------------------------------- 5. 마무리 (parchment) */}
      <Tile tone="parchment" innerClassName="text-center">
        <h2 className="t-display">지금 확인해 보세요</h2>
        <p className="t-lead mt-4 text-ink-2">
          1분이면 됩니다. 회원가입도, 이름도 필요하지 않습니다.
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
  n,
  icon,
  title,
  body,
}: {
  n: string;
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
        <span className="text-sm font-semibold text-on-dark-muted">{n}</span>
      </div>
      <h3 className="t-tagline mt-4">{title}</h3>
      <p className="mt-2 text-on-dark-muted">{body}</p>
    </li>
  );
}

/** 밝은 타일 위의 설명 카드 */
function Explain({
  title,
  sub,
  body,
}: {
  title: string;
  sub: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg p-6">
      <h3 className="t-tagline text-ink">
        {title} <span className="font-normal text-ink-3">{sub}</span>
      </h3>
      <p className="mt-3 text-ink-2">{body}</p>
    </div>
  );
}
