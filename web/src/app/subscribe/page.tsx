"use client";

/** 알림 신청 — 확인 이메일을 거친 뒤 자격(A) 기준 하루 한 번 발송. */
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
        이메일 확인을 마친 뒤, 저장된 인적사항의 자격 조건에 맞는 지원이 새로
        올라오거나 마감 7일 전이면 선정해 하루 한 번 이메일로 알려드립니다.
        &ldquo;원하는 것&rdquo; 자유입력은 저장하지 않으므로 알림에는 사용하지
        않습니다.
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
              수집 항목: 이메일 주소 · 이용 목적: 자격 조건 기반 일일 알림 발송 ·
              보유 기간: 알림 해지 시까지. 확인 전 이메일은 7일 뒤 삭제됩니다.
              해지하시면 등록하신 프로필까지 즉시 삭제됩니다. 자세한 내용은{" "}
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
            {busy ? "확인 이메일 보내는 중…" : "확인 이메일 보내기"}
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
        </div>
      )}

      <p className="mt-10 text-sm text-ink-3">
        알림 해지는 받은 이메일 하단의 링크에서 할 수 있습니다.
      </p>
    </div>
  );
}
