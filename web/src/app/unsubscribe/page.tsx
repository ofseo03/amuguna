"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function EmailAction() {
  const params = useSearchParams();
  const confirmToken = params.get("confirm");
  const unsubscribeToken = params.get("token");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const action = confirmToken ? "confirm" : unsubscribeToken ? "unsubscribe" : null;
  const token = confirmToken ?? unsubscribeToken;

  async function submit() {
    if (!action || !token) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/${action}/${encodeURIComponent(token)}`, { method: "POST" });
      const body = await response.json();
      setResult({ ok: Boolean(body.ok), message: body.message ?? "처리에 실패했습니다." });
    } catch {
      setResult({ ok: false, message: "네트워크 오류가 발생했습니다." });
    } finally {
      setBusy(false);
    }
  }

  if (!action) {
    return <p className="mt-8 text-ink-2">받은 이메일의 확인 또는 해지 링크를 열어 주세요.</p>;
  }

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={submit}
        disabled={busy || Boolean(result?.ok)}
        className="rounded-lg bg-brand px-7 py-3 font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-bg-sunken disabled:text-ink-3"
      >
        {busy ? "처리 중…" : action === "confirm" ? "이메일 알림 확인하기" : "알림 해지하기"}
      </button>
      {result && (
        <div
          role="status"
          className={`mt-6 rounded-lg border-2 px-5 py-4 ${result.ok ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft"}`}
        >
          <p className={`font-bold ${result.ok ? "text-ok" : "text-danger"}`}>
            {result.ok ? "완료" : "처리하지 못했습니다"}
          </p>
          <p className="mt-1 text-ink-2">{result.message}</p>
        </div>
      )}
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">이메일 알림</h1>
      <p className="mt-3 text-ink-2">
        이메일 확인 또는 알림 해지는 메일 링크를 연 뒤 아래 버튼으로 완료합니다.
        해지하시면 등록된 이메일과 프로필 정보가 즉시 삭제됩니다.
      </p>
      <Suspense fallback={<p className="mt-8 text-ink-2">불러오는 중…</p>}>
        <EmailAction />
      </Suspense>
      <p className="mt-10 text-sm text-ink-3">
        <Link href="/privacy" className="underline hover:text-brand">개인정보처리방침 보기</Link>
      </p>
    </div>
  );
}
