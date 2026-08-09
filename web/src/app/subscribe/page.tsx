"use client";

/** 알림 신청 (SPEC §9 화면 5) — 이메일 + 동의 체크. §11: MVP 는 수집만, 발송은 이후. */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function SubscribePage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    demoMode?: boolean;
    unsubscribeToken?: string;
  } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, consent }),
      });
      const body = await res.json();
      if (body.code === "no_profile") {
        router.push("/onboarding");
        return;
      }
      setResult({
        ok: Boolean(body.ok),
        message:
          body.message ?? body.errors?.[0]?.message ?? "처리 중 오류가 발생했습니다.",
        demoMode: Boolean(body.demoMode),
        unsubscribeToken:
          typeof body.unsubscribeToken === "string" ? body.unsubscribeToken : undefined,
      });
    } catch {
      setResult({ ok: false, message: "네트워크 오류가 발생했습니다." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">
        새 지원이 나오면 알려드릴까요?
      </h1>
      <p className="mt-3 text-ink-2">
        입력하신 조건에 맞는 지원이 새로 올라오거나 마감이 임박하면 이메일로
        알려드립니다. 알림은 선택 사항이며 언제든 1번의 클릭으로 해지할 수
        있습니다.
      </p>

      <form onSubmit={onSubmit} className="mt-8 grid gap-5">
        <div>
          <label htmlFor="email" className="block font-semibold text-ink">
            이메일 주소
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            aria-describedby="email-help"
            className="mt-2 w-full rounded-lg border-2 border-line bg-white px-4 py-3 text-lg text-ink focus:border-brand"
            placeholder="example@email.com"
          />
          <p id="email-help" className="mt-2 text-sm text-ink-3">
            알림 발송 외의 용도로 사용하지 않으며 제3자에게 제공하지 않습니다.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-bg-soft p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-[var(--brand)]"
            />
            <span className="text-ink-2">
              <strong className="text-ink">
                이메일 수집·이용에 동의합니다. (필수)
              </strong>
              <br />
              수집 항목: 이메일 주소 · 이용 목적: 맞춤 지원 정보 알림 발송 ·
              보유 기간: 알림 해지 시까지. 해지하시면 등록하신 프로필까지 즉시
              삭제됩니다. 자세한 내용은{" "}
              <Link href="/privacy" className="underline">
                개인정보처리방침
              </Link>
              을 확인해 주세요.
            </span>
          </label>
        </div>

        <div>
          <button
            type="submit"
            disabled={busy || !consent}
            className="rounded-lg bg-brand px-7 py-3 font-bold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:bg-bg-sunken disabled:text-ink-3"
          >
            {busy ? "신청 중…" : "알림 신청하기"}
          </button>
        </div>
      </form>

      {result && (
        <div
          role="status"
          className={`mt-6 rounded-lg border-2 px-5 py-4 ${
            result.ok ? "border-ok bg-ok-soft text-ink-2" : "border-danger bg-danger-soft"
          }`}
        >
          <p className={`font-bold ${result.ok ? "text-ok" : "text-danger"}`}>
            {result.ok ? "완료" : "신청하지 못했습니다"}
          </p>
          <p className="mt-1 text-ink-2">{result.message}</p>
          {result.ok && !result.demoMode && result.unsubscribeToken && (
            <div className="mt-4">
              <p className="text-sm text-ink-2">
                해지 코드는 다시 확인할 수 없습니다. 복사해 보관해 주세요. 이
                코드로 등록된 이메일과 프로필 정보를 언제든 즉시 삭제할 수
                있습니다.
              </p>
              <code className="mt-2 block break-all rounded bg-white px-3 py-2 text-ink">
                {result.unsubscribeToken}
              </code>
              <Link
                href={`/unsubscribe?token=${encodeURIComponent(result.unsubscribeToken)}`}
                className="mt-3 inline-block font-semibold text-brand-dark underline"
              >
                이 코드로 알림 해지하기
              </Link>
            </div>
          )}
        </div>
      )}

      <p className="mt-10 text-sm text-ink-3">
        이미 신청하셨나요?{" "}
        <Link href="/unsubscribe" className="underline hover:text-brand">
          알림 해지하기
        </Link>
      </p>
    </div>
  );
}
