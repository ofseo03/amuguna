import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-3xl font-bold text-ink">
        요청하신 페이지를 찾을 수 없습니다
      </h1>
      <p className="mt-3 text-ink-2">
        주소가 바뀌었거나 접수가 끝난 지원 정보일 수 있습니다.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="rounded-lg border-2 border-line bg-white px-5 py-3 font-semibold text-ink-2 no-underline hover:bg-bg-sunken"
        >
          처음으로
        </Link>
        <Link
          href="/onboarding"
          className="rounded-lg bg-brand px-5 py-3 font-bold text-white no-underline hover:bg-brand-dark"
        >
          내게 맞는 지원 찾기
        </Link>
      </div>
    </div>
  );
}
