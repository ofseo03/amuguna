import Link from "next/link";
import FontSizeToggle from "./FontSizeToggle";
import type { ProgramForm } from "@/lib/types";

/**
 * 전역 내비 — 순수 검정 띠. 이 사이트에서 #000 이 나오는 유일한 자리다.
 *
 * 원본 명세는 내비 링크를 12px 로 두지만 여기서는 14px 아래로 내리지 않는다.
 * 고령층 대상 서비스라 12px 는 그대로 이탈 사유가 된다 (§8).
 */
export function SiteHeader() {
  return (
    <header className="on-dark sticky top-0 z-50 bg-surface-black">
      <div className="mx-auto flex max-w-[68rem] flex-wrap items-center justify-between gap-x-3 px-5 py-1 sm:px-8">
        <Link
          href="/"
          className="flex min-h-[2.75rem] items-baseline gap-x-2 py-1 text-on-dark no-underline"
        >
          <span className="t-tagline">아무거나</span>
          <span className="hidden text-sm font-normal text-on-dark-muted sm:inline">
            내게 맞는 공공 금융정보
          </span>
        </Link>
        <FontSizeToggle />
      </div>
    </header>
  );
}

/**
 * 화면별 얇은 2단 내비 — 전역 내비 바로 아래에 붙는다.
 * parchment 80% + 배경 블러라 아래 내용 위에 떠 있는 것처럼 읽힌다.
 */
export function SubNav({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="frosted sticky top-[3.25rem] z-40 border-b border-line-soft">
      <div className="mx-auto flex max-w-[68rem] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5 sm:px-8">
        <p className="t-tagline text-ink">{title}</p>
        {children && (
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * SPEC §8 정확성 고지 — 상시 노출.
 *
 * 두 문장을 함께 둔다.
 * 1. 자격 판정의 한계 — 자동 판정은 참고이고 최종 확인은 소관 기관 몫이다
 * 2. 금융소비자보호법 대응 — 이 서비스는 금감원 공시 데이터를 **비교·정보 제공** 하는
 *    것이지 특정 금융상품의 계약을 권유하는 것이 아니다. 실제로도 그렇지만(사용자 입력
 *    조건에 맞는 공시 정보를 정렬해 보여줄 뿐 판매·중개·이익 관계가 없다), 문구가
 *    "당신께 추천"처럼 읽히면 권유·광고로 해석될 여지가 생기므로 명시한다.
 */
export function Disclaimer() {
  return (
    <div className="rounded-lg bg-bg-sunken px-5 py-4 text-sm text-ink-2">
      <p>본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다.</p>
      <p className="mt-1">
        공공기관이 공개한 정보를 조건에 맞게 비교·안내하는 서비스이며, 특정 금융상품의
        가입이나 계약을 권유하지 않습니다. 상품 선택과 계약은 이용자 본인의 판단과
        책임에 따릅니다.
      </p>
    </div>
  );
}

/**
 * 금융상품(대출·예적금 등) 화면에만 덧붙이는 고지.
 *
 * 상시 고지보다 한 걸음 더 들어가 출처와 성격을 밝힌다 — 금감원 공시를 그대로 옮긴
 * 것이며 조건은 금융회사·개인 신용도에 따라 달라진다는 점이 실제로 오해가 잦은 지점이다.
 */
export function FinancialProductNotice({ form }: { form: ProgramForm }) {
  const source = form === "product"
    ? "금융감독원 금융상품통합비교공시에 공개된"
    : "공공 API 또는 금융상품 비교공시에 공개된";
  const condition = form === "product"
    ? "실제 금리·판매 여부는 금융회사와 가입 기간·조건에 따라"
    : "실제 금리·한도·취급 여부는 금융회사와 개인 신용도에 따라";
  return (
    <p className="rounded-lg border border-line bg-bg px-5 py-4 text-sm text-ink-2">
      <strong className="text-ink">금융상품 안내</strong> · {source} 내용을 옮긴 비교 정보입니다. {condition} 달라지므로 해당 금융회사에서 확인하셔야
      합니다. 특정 상품의 가입을 권유하는 것이 아닙니다.
    </p>
  );
}

/**
 * 푸터만 의도적으로 촘촘하다 — 정보 구조 전체가 한눈에 보여야 하는 자리라서.
 * 대신 링크 행간을 넉넉히 벌려 훑을 수 있게 한다.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto bg-bg-soft">
      <div className="mx-auto max-w-[68rem] px-5 py-14 text-sm text-ink-2 sm:px-8">
        <p className="max-w-[80ch]">
          본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다. 공공기관이
          공개한 정보를 조건에 맞게 비교·안내하는 서비스이며, 특정 금융상품의 가입이나
          계약을 권유하지 않습니다.
        </p>
        <nav aria-label="사이트 정보" className="mt-6">
          <ul className="flex flex-wrap gap-x-8" style={{ lineHeight: 2.41 }}>
            <li>
              <Link href="/privacy" className="inline-block py-1 text-brand no-underline hover:underline">
                개인정보처리방침
              </Link>
            </li>
            <li>
              <Link href="/sources" className="inline-block py-1 text-brand no-underline hover:underline">
                데이터 출처·갱신 주기
              </Link>
            </li>
          </ul>
        </nav>
        <p className="mt-6 border-t border-line pt-6 text-ink-3">
          2026 금융 AI Challenge 출품작 · 회원가입 없이 익명으로 이용합니다.
        </p>
      </div>
    </footer>
  );
}
