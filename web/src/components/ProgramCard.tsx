import Link from "next/link";
import { dDayLabel, isUrgent, issuerLevelLabel } from "@/lib/format";
import { FORM_LABEL } from "@/lib/forms";
import type { MatchCard, NearMissCard } from "@/lib/types";

/**
 * 결과 카드 (SPEC §9 화면 3) — 제목 / 한 줄 요약 / 마감 D-n / 매칭 근거 배지.
 *
 * 요약을 뺐더니 근접탈락 카드에만 설명이 남아 **대상이 아닌 것만 뭔지 알 수 있는** 화면이 됐다.
 * 목록에서 무엇을 고를지 판단할 근거가 없으면 카드 수만큼 상세를 들락거리게 된다.
 * 지원금액은 상세 화면에서만 보여준다.
 */
export function ProgramCard({ card, returnHref }: { card: MatchCard; returnHref: string }) {
  const p = card.program;
  const urgent = isUrgent(card.dDay);

  return (
    <li className="rounded-lg border border-line bg-bg p-5 transition-colors hover:border-ink-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-bg-sunken px-2 py-0.5 font-semibold text-ink-2">
          {FORM_LABEL[p.form]}
        </span>
        <span className="text-ink-3">{issuerLevelLabel(p.issuer_level)}</span>
        <span aria-hidden="true" className="text-ink-3">
          ·
        </span>
        <span className="text-ink-3">{p.issuer}</span>
        <span
          className={`ml-auto rounded px-2 py-0.5 font-bold ${
            urgent ? "bg-danger-soft text-danger" : "bg-bg-sunken text-ink-2"
          }`}
        >
          {card.dDay === null ? "상시 접수" : `마감 ${dDayLabel(card.dDay)}`}
        </span>
      </div>

      <h3 className="text-lg font-bold leading-snug text-ink">
        <Link
          href={`/programs/${p.id}?from=${encodeURIComponent(returnHref)}`}
          className="inline-block py-0.5 no-underline hover:text-brand hover:underline"
        >
          {p.title}
        </Link>
      </h3>

      <p className="mt-1 text-ink-2">{p.summary}</p>

      {/* 매칭 근거 — 저장된 문구가 아니라 요청 시점에 템플릿으로 조립한다 */}
      <div className="mt-4 border-t border-line-soft pt-3">
        <p className="mb-2 text-sm text-ink-2">
          <span className="font-semibold text-ok">매칭 근거</span> ·{" "}
          {card.reason}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {card.badges.map((b) => (
            <li
              key={b}
              className="rounded-full bg-ok-soft px-2.5 py-0.5 text-sm font-semibold text-ok"
            >
              {b}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/** 근접 탈락 카드 (SPEC §7.6) */
export function NearMissItem({ card, returnHref }: { card: NearMissCard; returnHref: string }) {
  const p = card.program;
  return (
    <li className="rounded-xl border border-warn bg-warn-soft p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-ink-3">
        <span className="rounded bg-bg px-2 py-0.5 font-semibold text-ink-2">
          {FORM_LABEL[p.form]}
        </span>
        <span>{p.issuer}</span>
        <span className="ml-auto font-semibold">
          {card.dDay === null ? "상시" : `마감 ${dDayLabel(card.dDay)}`}
        </span>
      </div>
      <h3 className="font-bold text-ink">
        <Link
          href={`/programs/${p.id}?from=${encodeURIComponent(returnHref)}`}
          className="inline-block py-0.5 no-underline hover:text-brand hover:underline"
        >
          {p.title}
        </Link>
      </h3>
      <p className="mt-2 font-semibold text-warn">{card.message}</p>
      <p className="mt-1 text-sm text-ink-2">{p.summary}</p>
    </li>
  );
}
