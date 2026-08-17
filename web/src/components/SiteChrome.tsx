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

/** SPEC §8 정확성 고지 — 상시 노출 */
export function Disclaimer() {
  return (
    <p className="rounded-lg bg-bg-sunken px-4 py-3 text-sm text-ink-2">
      본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다.
    </p>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-bg-soft">
      <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-ink-2">
        <p className="mb-4">
          본 정보는 참고용이며 최종 자격 판정은 소관 기관 확인이 필요합니다.
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
