"use client";

/**
 * 알림 해지 (SPEC §9 화면 5 / §8).
 * 이메일 링크는 /api/unsubscribe/:token 을 직접 호출한다.
 * 이 화면은 링크를 잃어버린 사용자를 위한 토큰 직접 입력 경로다.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function UnsubscribeForm() {
  const params = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/unsubscribe/${encodeURIComponent(token.trim())}`);
      const body = await res.json();
      setResult({ ok: Boolean(body.ok), message: body.message ?? "처리에 실패했습니다." });
    } catch {
      setResult({ ok: false, message: "네트워크 오류가 발생했습니다." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} className="mt-8 grid gap-5">
        <div>
          <label htmlFor="token" className="block font-semibold text-ink">
            해지 코드
          </label>
          <input
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            aria-describedby="token-help"
            className="mt-2 w-full rounded-lg border-2 border-line bg-white px-4 py-3 font-mono text-ink focus:border-brand"
            placeholder="알림 메일 하단의 해지 링크에 포함된 코드"
          />
          <p id="token-help" className="mt-2 text-sm text-ink-3">
            보내드린 알림 메일의 &ldquo;알림 해지&rdquo; 링크를 누르시면 코드
            입력 없이 바로 해지됩니다.
          </p>
        </div>
        <div>
          <button
            type="submit"
            disabled={busy || token.trim().length === 0}
            className="rounded-lg bg-brand px-7 py-3 font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-bg-sunken disabled:text-ink-3"
          >
            {busy ? "처리 중…" : "알림 해지하기"}
          </button>
        </div>
      </form>

      {result && (
        <div
          role="status"
          className={`mt-6 rounded-lg border-2 px-5 py-4 ${
            result.ok ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft"
          }`}
        >
          <p className={`font-bold ${result.ok ? "text-ok" : "text-danger"}`}>
            {result.ok ? "해지되었습니다" : "해지하지 못했습니다"}
          </p>
          <p className="mt-1 text-ink-2">{result.message}</p>
        </div>
      )}
    </>
  );
}

export default function UnsubscribePage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">알림 해지</h1>
      <p className="mt-3 text-ink-2">
        해지하시면 등록된 이메일뿐 아니라 저장된 프로필 정보까지 즉시
        삭제됩니다. 남는 정보가 없습니다.
      </p>

      <Suspense
        fallback={<p className="mt-8 text-ink-2">불러오는 중…</p>}
      >
        <UnsubscribeForm />
      </Suspense>

      <p className="mt-10 text-sm text-ink-3">
        <Link href="/privacy" className="underline hover:text-brand">
          개인정보처리방침 보기
        </Link>
      </p>
    </div>
  );
}
