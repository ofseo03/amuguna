/**
 * 상세 화면 (SPEC §9 화면 4).
 * 자격 체크리스트(내 프로필 대조 ✅/❌) · extra_conditions 추가 확인 필요 · 금액/기한 ·
 * 신청 절차 3단계 · 원문 링크 + 수집 시각 · 참고용 고지.
 *
 * 서버 컴포넌트 — 세션 쿠키의 프로필을 직접 읽어 대조한다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProgram } from "@/lib/matching";
import { checklist, DIMENSION_LABEL, dDay, evaluate } from "@/lib/eligibility";
import { readProfile } from "@/lib/session";
import { FORM_LABEL } from "@/lib/forms";
import { dDayLabel, formatDate, formatDateTime, isUrgent, issuerLevelLabel } from "@/lib/format";
import { Disclaimer } from "@/components/SiteChrome";
import Term from "@/components/Term";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const program = await getProgram(Number(id)).catch(() => null);
  if (!program) return { title: "지원 정보를 찾을 수 없습니다" };
  return { title: program.title, description: program.summary };
}

export default async function ProgramDetailPage({ params }: Props) {
  const { id } = await params;
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) notFound();

  const program = await getProgram(numeric);
  if (!program) notFound();

  const profile = await readProfile();
  const checks = profile ? checklist(program.rules, profile) : null;
  const ev = profile ? evaluate(program.rules, profile) : null;
  const d = dDay(program);
  const extras = program.rules.extra_conditions ?? [];

  return (
    <article className="mx-auto max-w-3xl px-4 py-8">
      <nav aria-label="이동" className="mb-6">
        <Link href="/results" className="text-ink-2 underline hover:text-brand">
          ← 결과 목록으로
        </Link>
      </nav>

      {/* ---------------- 헤더 ---------------- */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded bg-bg-sunken px-2 py-0.5 font-semibold text-ink-2">
          {FORM_LABEL[program.form]}
        </span>
        <span className="text-ink-3">{issuerLevelLabel(program.issuer_level)}</span>
        <span aria-hidden="true" className="text-line">·</span>
        <span className="text-ink-3">{program.issuer}</span>
      </div>

      <h1 className="mt-2 text-2xl font-bold leading-snug text-ink sm:text-3xl">
        {program.title}
      </h1>
      <p className="mt-2 text-lg text-ink-2">{program.summary}</p>

      {/* ---------------- 자격 판정 요약 ---------------- */}
      {ev && (
        <div
          className={`mt-6 rounded-xl border-2 px-5 py-4 ${
            ev.violations === 0
              ? "border-ok bg-ok-soft"
              : "border-warn bg-warn-soft"
          }`}
        >
          <p className="text-lg font-bold">
            {ev.violations === 0 && ev.unknownDimensions.length === 0 ? (
              <span className="text-ok">✅ 입력하신 정보로는 대상에 해당합니다</span>
            ) : ev.violations === 0 ? (
              <span className="text-warn">⚠️ 입력하지 않은 조건을 추가로 확인해 주세요</span>
            ) : (
              <span className="text-warn">
                ⚠️ 조건 {ev.violations}개가 맞지 않습니다
              </span>
            )}
          </p>
          <p className="mt-1 text-sm text-ink-2">
            아래 체크리스트에서 항목별로 확인하실 수 있습니다. 추가 확인이 필요한
            조건은 자동 판정하지 않습니다.
          </p>
        </div>
      )}

      {!profile && (
        <p className="mt-6 rounded-xl border border-line bg-bg-soft px-5 py-4 text-ink-2">
          기본 정보를 입력하시면 이 지원의 자격 요건을 내 정보와 대조해
          보여드립니다.{" "}
          <Link href="/onboarding" className="font-semibold underline">
            정보 입력하기
          </Link>
        </p>
      )}

      {/* ---------------- 금액 / 기한 ---------------- */}
      <section aria-labelledby="facts" className="mt-8">
        <h2 id="facts" className="text-xl font-bold text-ink">
          지원 금액과 기한
        </h2>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          <Fact label="지원 금액" value={program.benefit_amount_text ?? "금액 정보 없음"} />
          <Fact
            label="접수 기한"
            value={
              program.is_always_open || !program.ends_at ? (
                <Term name="상시">상시 접수</Term>
              ) : (
                <>
                  {formatDate(program.ends_at)}까지{" "}
                  <span className={isUrgent(d) ? "font-bold text-danger" : "text-ink-2"}>
                    ({dDayLabel(d)})
                  </span>
                </>
              )
            }
          />
          <Fact label="신청 방법" value={program.apply_method ?? "원문 확인 필요"} />
          <Fact
            label="접수 시작"
            value={program.starts_at ? formatDate(program.starts_at) : "상시"}
          />
        </dl>
      </section>

      {/* ---------------- 자격 체크리스트 ---------------- */}
      {checks && (
        <section aria-labelledby="checklist" className="mt-10">
          <h2 id="checklist" className="text-xl font-bold text-ink">
            자격 체크리스트
          </h2>
          <p className="mt-1 text-ink-2">
            입력하신 정보와 공고문의 자격요건을 항목별로 대조한 결과입니다.
          </p>
          <ul className="mt-4 grid gap-2">
            {checks.map((c) => (
              <li
                key={c.dimension}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 ${
                  !c.constrained
                    ? "border-line-soft bg-bg-soft"
                    : c.unknown
                      ? "border-warn bg-warn-soft"
                    : c.pass
                      ? "border-ok bg-ok-soft"
                      : "border-danger bg-danger-soft"
                }`}
              >
                <span aria-hidden="true" className="text-lg">
                  {!c.constrained ? "➖" : c.unknown ? "⚠️" : c.pass ? "✅" : "❌"}
                </span>
                <span className="sr-only">
                  {!c.constrained ? "조건 없음" : c.unknown ? "추가 확인 필요" : c.pass ? "충족" : "미충족"}
                </span>
                <span className="w-20 font-semibold text-ink">
                  {DIMENSION_LABEL[c.dimension]}
                </span>
                <span className="text-ink-2">
                  요건 <strong className="text-ink">{c.requirement}</strong>
                </span>
                <span className="ml-auto text-sm text-ink-3">내 정보 {c.mine}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-ink-3">
            ➖ 는 이 지원에 해당 조건이 없다는 뜻입니다. 조건이 없으면 통과로
            봅니다.
          </p>
        </section>
      )}

      {/* ---------------- extra_conditions (§6.3) ---------------- */}
      <section aria-labelledby="extras" className="mt-10">
        <h2 id="extras" className="text-xl font-bold text-ink">
          추가 확인 필요 조건
        </h2>
        {extras.length === 0 ? (
          <p className="mt-2 text-ink-2">추가로 확인해야 할 조건이 없습니다.</p>
        ) : (
          <>
            <p className="mt-1 text-ink-2">
              아래 조건은 자동으로 판정하지 않습니다. 잘못 탈락시키지 않기 위해
              그대로 보여드리니 직접 확인해 주세요.
            </p>
            <ul className="mt-4 grid gap-2">
              {extras.map((e, i) => (
                <li
                  key={`${e.label}-${i}`}
                  className="rounded-lg border border-line bg-white px-4 py-3"
                >
                  <p className="font-semibold text-ink">□ {e.label}</p>
                  <p className="mt-1 text-sm text-ink-2">{e.text}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---------------- 신청 절차 ---------------- */}
      {program.apply_steps.length > 0 && (
        <section aria-labelledby="steps" className="mt-10">
          <h2 id="steps" className="text-xl font-bold text-ink">
            신청 절차
          </h2>
          <ol className="mt-4 grid gap-3">
            {program.apply_steps.map((s, i) => (
              <li key={i} className="flex gap-4 rounded-lg border border-line bg-white p-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand font-bold text-white">
                  {i + 1}
                </span>
                <span className="text-ink-2">{s}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ---------------- 공고 본문 ---------------- */}
      <section aria-labelledby="body" className="mt-10">
        <h2 id="body" className="text-xl font-bold text-ink">
          공고 내용
        </h2>
        <div className="mt-3 grid gap-3 rounded-xl border border-line bg-bg-soft p-5 text-ink-2">
          {program.body_text.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </section>

      {/* ---------------- 출처 (§8 정확성 고지) ---------------- */}
      <section aria-labelledby="source" className="mt-10">
        <h2 id="source" className="text-xl font-bold text-ink">
          출처
        </h2>
        <div className="mt-3 rounded-xl border border-line bg-white p-5">
          <p className="text-ink-2">
            <span className="font-semibold text-ink">원문</span>{" "}
            <a
              href={program.source_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="break-all underline hover:text-brand"
            >
              {program.source_url}
            </a>
          </p>
          <p className="mt-2 text-ink-2">
            <span className="font-semibold text-ink">수집 시각</span>{" "}
            {formatDateTime(program.fetched_at)}
          </p>
          <p className="mt-2 text-sm text-ink-3">
            발행 기관 {program.issuer} · 식별자 {program.external_id} · 자격요건
            추출 방식 {program.rules.parse_method}
          </p>
          {program.apply_url && (
            <a
              href={program.apply_url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-4 inline-block rounded-lg bg-brand px-6 py-3 font-bold text-white no-underline hover:bg-brand-dark"
            >
              신청 페이지로 이동 ↗
            </a>
          )}
        </div>
      </section>

      <div className="mt-8">
        <Disclaimer />
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-white px-5 py-4">
      <dt className="text-sm font-semibold text-ink-3">{label}</dt>
      <dd className="mt-1 text-ink">{value}</dd>
    </div>
  );
}
