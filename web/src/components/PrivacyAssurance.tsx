import Link from "next/link";
import { CheckMark } from "./visual/Icon";

/**
 * 온보딩 아래 안심 안내 (SPEC §8).
 *
 * 낯선 사이트에 나이·소득을 입력하는 화면이라 "이거 어디 남는 거지?" 가 가장 큰 이탈
 * 이유다. 개인정보를 DB 에 저장하지 않는다는 건 이 서비스의 실제 설계이므로
 * 입력하는 자리에서 바로 보여준다.
 *
 * 문구는 /privacy 의 서술과 같은 사실만 쓴다 — 안심 문구가 실제 동작보다 앞서 나가면
 * 그 자체가 거짓 고지가 된다. 표현이 달라지면 두 곳을 함께 고쳐야 한다.
 */

const POINTS = [
  "이름·연락처·주민등록번호를 묻지 않습니다.",
  "입력한 인적사항은 브라우저 쿠키에만 담기고 데이터베이스에 저장하지 않습니다.",
  "쿠키는 90일 뒤 만료되며, 브라우저에서 지우면 즉시 사라집니다.",
];

export default function PrivacyAssurance() {
  return (
    <aside className="mt-10 rounded-lg border border-line bg-bg-soft p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-7 w-7"
          >
            <path d="M12 3 20 6v6c0 4.4-3.2 7.9-8 9-4.8-1.1-8-4.6-8-9V6l8-3Z" />
            <path d="M9.6 11.5V10a2.4 2.4 0 0 1 4.8 0v1.5" />
            <rect x="8.8" y="11.5" width="6.4" height="4.6" rx="1" />
          </svg>
        </span>

        <div className="min-w-0">
          <h2 className="font-bold text-ink">입력하신 정보는 남지 않습니다</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-sm text-ink-2">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok"
                >
                  <CheckMark className="h-2.5 w-2.5" />
                </span>
                {p}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm">
            <Link href="/privacy" className="inline-block py-1 text-brand hover:underline">
              개인정보처리방침 자세히 보기
            </Link>
          </p>
        </div>
      </div>
    </aside>
  );
}
