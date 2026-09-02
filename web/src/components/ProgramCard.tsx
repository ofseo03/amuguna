import Link from "next/link";
import { dDayLabel, externalHttpUrl, formatDateTime, isUrgent, issuerLevelLabel } from "@/lib/format";
import { FORM_LABEL } from "@/lib/forms";
import type { MatchCard, NearMissCard } from "@/lib/types";

/** 결과 카드 (SPEC §9 화면 3) — 제목 / 마감 D-n / 매칭 근거 배지 (요약·지원금액은 상세 화면에서만) */
export function ProgramCard({ card }: { card: MatchCard }) {
  const p = card.program;
  const urgent = isUrgent(card.dDay);
  const sourceUrl = externalHttpUrl(p.source_url);

  return (
    <li className="rounded-lg border border-line bg-bg p-5 transition-colors hover:border-ink-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-bg-sunken px-2 py-0.5 font-semibold text-ink-2">
          {FORM_LABEL[p.form]}
        </span>
        <span className="text-ink-3">{issuerLevelLabel(p.issuer_level, p.form)}</span>
        <span aria-hidden="true" className="text-ink-3">
          ·
        </span>
        <span className="text-ink-3">{p.issuer}</span>
        <span className={`rounded px-2 py-0.5 font-semibold ${
          card.eligibilityStatus === "likely"
            ? "bg-ok-soft text-ok"
            : "bg-warn-soft text-warn"
        }`}>
          {card.eligibilityStatus === "likely" ? "대상 가능성 높음" : "확인 필요"}
        </span>
        <span
          className={`ml-auto rounded px-2 py-0.5 font-bold ${
            urgent ? "bg-danger-soft text-danger" : "bg-bg-sunken text-ink-2"
          }`}
        >
          {card.dDay === null
            ? p.form === "product" ? "현재 공시 중" : "상시 접수"
            : `마감 ${dDayLabel(card.dDay)}`}
        </span>
      </div>

      <h3 className="text-lg font-bold leading-snug text-ink">
        <Link
          href={`/programs/${p.id}`}
          className="inline-block py-0.5 no-underline hover:text-brand hover:underline"
        >
          {p.title}
        </Link>
      </h3>

      {/* 매칭 근거 — 저장된 문구가 아니라 요청 시점에 템플릿으로 조립한다 */}
      <div className="mt-4 border-t border-line-soft pt-3">
        <p className="mb-2 text-sm text-ink-2">
          <span className={`font-semibold ${card.eligibilityStatus === "likely" ? "text-ok" : "text-warn"}`}>
            {card.eligibilityStatus === "likely" ? "매칭 근거" : "확인할 내용"}
          </span> ·{" "}
          {card.reason}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {card.badges.map((b) => (
            <li
              key={b}
              className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${
                card.eligibilityStatus === "likely"
                  ? "bg-ok-soft text-ok"
                  : "bg-warn-soft text-warn"
              }`}
            >
              {b}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-4 flex flex-wrap gap-x-3 border-t border-line-soft pt-3 text-sm text-ink-3">
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-semibold text-brand underline"
          >
            공고 원문 ↗
          </a>
        )}
        <span>수집 {formatDateTime(p.fetched_at)}</span>
      </p>
    </li>
  );
}

/** 근접 탈락 카드 (SPEC §7.6) */
export function NearMissItem({ card }: { card: NearMissCard }) {
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
          href={`/programs/${p.id}`}
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
