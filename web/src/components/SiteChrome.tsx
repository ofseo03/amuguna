import Link from "next/link";
import FontSizeToggle from "./FontSizeToggle";

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link
          href="/"
          className="flex items-baseline gap-2 text-xl font-bold text-ink no-underline"
        >
          <span className="text-brand">아무거나</span>
          <span className="text-sm font-normal text-ink-3">
            내게 맞는 공공 금융정보
          </span>
        </Link>
        <FontSizeToggle />
      </div>
    </header>
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
    <div className="rounded-lg bg-bg-sunken px-4 py-3 text-sm text-ink-2">
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
export function FinancialProductNotice() {
  return (
    <p className="rounded-lg border border-line bg-white px-4 py-3 text-sm text-ink-2">
      <strong className="text-ink">금융상품 안내</strong> · 금융감독원
      금융상품통합비교공시에 공개된 내용을 그대로 옮긴 비교 정보입니다. 실제 금리·한도·
      취급 여부는 금융회사와 개인 신용도에 따라 달라지므로 해당 금융회사에서 확인하셔야
      합니다. 특정 상품의 가입을 권유하는 것이 아닙니다.
    </p>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-bg-soft">
      <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-ink-2">
        <p className="mb-4">
          본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다. 공공기관이
          공개한 정보를 조건에 맞게 비교·안내하는 서비스이며, 특정 금융상품의 가입이나
          계약을 권유하지 않습니다.
        </p>
        <nav aria-label="사이트 정보">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link href="/privacy" className="underline hover:text-brand">
                개인정보처리방침
              </Link>
            </li>
            <li>
              <Link href="/sources" className="underline hover:text-brand">
                데이터 출처·갱신 주기
              </Link>
            </li>
          </ul>
        </nav>
        <p className="mt-5 text-ink-3">
          2026 금융 AI Challenge 출품작 · 회원가입 없이 익명으로 이용합니다.
        </p>
      </div>
    </footer>
  );
}
