import Link from "next/link";
import { isDbConfigured } from "@/lib/db";

// 데모 모드 배너가 배포 환경의 실제 환경변수를 반영해야 하므로 요청 시 렌더한다.
// (빌드 시점에 정적으로 굳으면 DATABASE_URL 을 나중에 넣어도 계속 "데모 모드"라고 표시된다)
export const dynamic = "force-dynamic";

export default function LandingPage() {
  const demo = !isDbConfigured();

  return (
    <div className="mx-auto max-w-5xl px-4">
      <section className="py-16 sm:py-24">
        <p className="mb-4 inline-block rounded-full bg-brand-soft px-3 py-1 text-sm font-semibold text-brand-dark">
          회원가입 없음 · 익명 이용
        </p>

        {/* 한 문장 가치 제안 (§9 화면 1) */}
        <h1 className="max-w-3xl text-3xl font-bold leading-tight text-ink sm:text-5xl">
          받을 수 있는데 몰라서 못 받는 돈,
          <br />
          <span className="text-brand">1분이면 찾습니다.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-lg text-ink-2">
          나이·지역·소득 같은 기본 정보만 고르면, 흩어져 있는 정부·지자체·공공기관의
          지원금과 대출·금융상품 중에서 <strong>내가 실제로 대상이 되는 것</strong>만
          골라 보여드립니다.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-4">
          <Link
            href="/onboarding"
            className="inline-block rounded-xl bg-brand px-8 py-4 text-lg font-bold text-white no-underline shadow-sm transition-colors hover:bg-brand-dark"
          >
            1분 만에 확인하기
          </Link>
          <span className="text-sm text-ink-3">
            이름·연락처·주민번호를 묻지 않습니다.
          </span>
        </div>

        {demo && (
          <p className="mt-6 max-w-2xl rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm text-ink-2">
            <strong className="text-warn">데모 모드</strong> — 데이터베이스가
            연결되지 않아 번들 예시 데이터 22건으로 동작 중입니다. 매칭·스코어링·
            근접탈락 로직은 실제와 동일합니다.
          </p>
        )}
      </section>

      <section className="border-t border-line py-14">
        <h2 className="text-2xl font-bold text-ink">
          왜 검색해도 안 나왔을까요?
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <Card
            n="01"
            title="흩어져 있습니다"
            body="지원 정보는 부처·지자체·공공기관 사이트에 따로 올라옵니다. 어디를 봐야 할지부터 막힙니다."
          />
          <Card
            n="02"
            title="자격이 조합형입니다"
            body="'만 19~34세, 중위소득 150% 이하, 무주택, 6개월 이상 거주' — 공고문을 끝까지 읽어야 내가 대상인지 압니다."
          />
          <Card
            n="03"
            title="필요한 사람일수록 어렵습니다"
            body="고령층·저소득층일수록 찾기 어려운데, 지원이 가장 필요한 것도 그분들입니다."
          />
        </div>
      </section>

      <section className="border-t border-line py-14">
        <h2 className="text-2xl font-bold text-ink">두 가지를 동시에 봅니다</h2>
        <p className="mt-3 max-w-2xl text-ink-2">
          자격만 맞추면 관계없는 정보가 수백 건 쏟아지고, 검색어만 맞추면 대상도
          아닌 것을 권하게 됩니다. 두 축이 겹치는 지점만 보여드립니다.
        </p>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-bg-soft p-6">
            <h3 className="text-lg font-bold text-ink">
              ① 내가 대상인가 <span className="text-ink-3">(자격)</span>
            </h3>
            <p className="mt-2 text-ink-2">
              나이·성별·직업·지역·소득분위 5가지를 공고문에서 뽑아낸 자격요건과
              하나씩 대조합니다. 조건이 없는 항목은 통과로 봅니다 — 빠뜨리는 쪽이
              더 손해이기 때문입니다.
            </p>
          </div>
          <div className="rounded-xl border border-line bg-bg-soft p-6">
            <h3 className="text-lg font-bold text-ink">
              ② 내가 찾는 것인가 <span className="text-ink-3">(의도)</span>
            </h3>
            <p className="mt-2 text-ink-2">
              &ldquo;보증금 올려달래서 대출 알아봐요&rdquo; 처럼 한 줄만 적으면
              뜻이 가까운 공고를 찾아냅니다. 뭘 찾을지 모르겠다면 건너뛰어도
              됩니다.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-line py-14">
        <h2 className="text-2xl font-bold text-ink">이렇게 알려드립니다</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          <Bullet>
            카드마다 <strong>왜 매칭됐는지</strong> — &ldquo;만 28세 · 서울 거주 ·
            3분위 조건에 해당합니다&rdquo;
          </Bullet>
          <Bullet>
            상세 화면에 <strong>자격 체크리스트</strong> — 항목별로 내 정보와
            대조해 ✅ / ❌ 표시
          </Bullet>
          <Bullet>
            조건이 <strong>하나만 어긋난 지원</strong>도 따로 알려드립니다 —
            &ldquo;소득 2분위 이하면 대상입니다&rdquo;
          </Bullet>
          <Bullet>
            모든 카드에 <strong>원문 링크와 수집 시각</strong>을 표시합니다
          </Bullet>
        </ul>

        <div className="mt-10">
          <Link
            href="/onboarding"
            className="inline-block rounded-xl bg-brand px-8 py-4 text-lg font-bold text-white no-underline transition-colors hover:bg-brand-dark"
          >
            1분 만에 확인하기
          </Link>
        </div>
      </section>
    </div>
  );
}

function Card({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-line p-6">
      <span className="text-sm font-bold text-brand">{n}</span>
      <h3 className="mt-2 text-lg font-bold text-ink">{title}</h3>
      <p className="mt-2 text-ink-2">{body}</p>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-lg border border-line-soft bg-white p-4 text-ink-2">
      <span aria-hidden="true" className="font-bold text-brand">
        ·
      </span>
      <span>{children}</span>
    </li>
  );
}
