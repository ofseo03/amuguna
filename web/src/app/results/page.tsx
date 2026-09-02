"use client";

/**
 * 결과 화면 (SPEC §9 화면 3).
 * 매칭 요약 배너 + form 탭 + 카드 리스트 + 근접탈락 + 완화 안내 + 페이지네이션(20건).
 *
 * 자유입력은 sessionStorage 에서만 읽어 /api/match 로 보낸다 — URL 이나 서버에 남기지 않는다 (§8).
 * (form, cursor) 조합별로 응답을 캐시해 탭 전환 때마다 rate limit 을 소모하지 않게 한다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NearMissItem, ProgramCard } from "@/components/ProgramCard";
import { Disclaimer, FinancialProductNotice, SubNav } from "@/components/SiteChrome";
import Term from "@/components/Term";
import StepTrail from "@/components/StepTrail";
import { FORMS, FORM_LABEL, isFinancialProduct } from "@/lib/forms";
import { QUERY_STORAGE_KEY } from "@/lib/client-keys";
import type { AiAnswerStatus, MatchResponse, ProgramForm } from "@/lib/types";

type Tab = ProgramForm | "all";
type Payload = MatchResponse & { ok: true };

export default function ResultsPage() {
  const [tab, setTab] = useState<Tab>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; noProfile?: boolean } | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiAnswerStatus, setAiAnswerStatus] = useState<AiAnswerStatus>("not_requested");

  const cache = useRef(new Map<string, Payload>());
  /**
   * 마지막으로 보낸 요청의 순번. 응답이 도착했을 때 이 값과 다르면 그 사이 다른 탭·페이지를
   * 눌렀다는 뜻이므로 버린다 — 느린 응답이 늦게 와서 새 탭 위에 옛 카드를 그리지 않게 한다.
   */
  const reqSeq = useRef(0);

  type Outcome =
    | { kind: "ok"; payload: Payload }
    | { kind: "error"; message: string; noProfile: boolean };

  /**
   * 순수 fetch — 상태를 건드리지 않고 결과만 돌려준다.
   * 상태 갱신은 전부 호출부의 .then 안에서 일어나므로 effect 본문에서 동기 setState 가 없다.
   */
  const fetchMatch = useCallback(
    (nextTab: Tab, nextCursor: string | null, q: string | null): Promise<Outcome> => {
      const key = `${nextTab}|${nextCursor ?? "first"}`;
      const hit = cache.current.get(key);
      if (hit) return Promise.resolve({ kind: "ok", payload: hit });

      return fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, form: nextTab, cursor: nextCursor }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok || !body.ok) {
            return {
              kind: "error" as const,
              message: body?.message ?? "결과를 불러오지 못했습니다.",
              noProfile: body?.code === "no_profile",
            };
          }
          cache.current.set(key, body as Payload);
          return { kind: "ok" as const, payload: body as Payload };
        })
        .catch(() => ({
          kind: "error" as const,
          message: "네트워크 오류가 발생했습니다.",
          noProfile: false,
        }));
    },
    [],
  );

  const apply = useCallback((outcome: Outcome, q: string | null) => {
    setQuery(q);
    if (outcome.kind === "ok") {
      setData(outcome.payload);
      // 탭·페이지 응답은 not_requested 이므로 최초 전체 검색의 안내를 그대로 유지한다.
      if (outcome.payload.aiAnswerStatus !== "not_requested") {
        setAiAnswer(outcome.payload.aiAnswer);
        setAiAnswerStatus(outcome.payload.aiAnswerStatus);
      }
      setError(null);
    } else {
      setError({ message: outcome.message, noProfile: outcome.noProfile });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 자유입력은 URL 이 아니라 탭 메모리에서만 읽는다 (§8 — 서버·주소창에 남기지 않는다)
    const q = window.sessionStorage.getItem(QUERY_STORAGE_KEY);
    const seq = ++reqSeq.current;
    void fetchMatch("all", null, q).then((o) => {
      if (!cancelled && seq === reqSeq.current) apply(o, q);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchMatch, apply]);

  function navigate(nextTab: Tab, nextCursor: string | null) {
    setTab(nextTab);
    setCursor(nextCursor);
    setLoading(true);
    const seq = ++reqSeq.current;
    void fetchMatch(nextTab, nextCursor, query).then((o) => {
      if (seq === reqSeq.current) apply(o, query);
    });
  }

  function changeTab(t: Tab) {
    navigate(t, null);
  }

  function nextPage() {
    if (!data?.nextCursor) return;
    navigate(tab, data.nextCursor);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ----------------------------- 에러/로딩 ----------------------------- */

  if (error?.noProfile) {
    return (
      <Shell subNav={false}>
        <div className="rounded-lg border border-line bg-bg-soft p-8 text-center">
          <h1 className="text-xl font-bold text-ink">먼저 기본 정보가 필요합니다</h1>
          <p className="mt-2 text-ink-2">
            나이·지역·소득 등 6단계를 입력하시면 결과를 보여드립니다.
          </p>

          {/* 6단계가 어떤 질문인지 미리 보여준다 — 무엇을 묻는지 알면 시작 문턱이 낮다 */}
          <div className="mx-auto mt-8 max-w-md">
            <StepTrail step={0} />
          </div>

          <Link
            href="/onboarding"
            className="mt-8 inline-block rounded-lg bg-brand px-6 py-3 font-bold text-white no-underline hover:bg-brand-dark"
          >
            정보 입력하러 가기
          </Link>
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div role="alert" className="rounded-xl border border-danger bg-danger-soft p-6">
          <h1 className="font-bold text-danger">{error.message}</h1>
          <button
            type="button"
            onClick={() => navigate(tab, cursor)}
            className="mt-4 rounded-lg border-2 border-danger bg-bg px-5 py-2 font-semibold text-danger"
          >
            다시 시도
          </button>
        </div>
      </Shell>
    );
  }

  if (loading && !data) {
    return (
      <Shell>
        <p aria-live="polite" className="py-16 text-center text-lg text-ink-2">
          내게 맞는 지원을 찾고 있습니다…
        </p>
      </Shell>
    );
  }

  if (!data) return null;

  const { summary, cards, nearMisses, relaxationNotice, nextCursor, demoMode, degraded } = data;

  /*
    콜드 스타트 (SPEC §3.2).
    첫 배포 직후나 초기 적재가 진행 중인 동안에는 DB 에 공고가 아직 없을 수 있다.
    "내 조건에 맞는 게 없다"와 "아직 데이터가 없다"는 전혀 다른 사실인데 둘 다
    빈 화면으로 보이면 서비스가 고장 난 것으로 읽힌다. 완화 안내·탭·근접탈락을
    전부 걷어내고 상태만 분명히 알린다.
  */
  if (data.catalogEmpty) {
    return (
      <Shell>
        <div
          role="status"
          className="rounded-xl border-2 border-brand bg-brand-soft px-6 py-10 text-center"
        >
          <h1 className="text-xl font-bold text-ink sm:text-2xl">
            아직 보여드릴 지원 정보를 준비하는 중입니다
          </h1>
          <p className="mt-3 text-ink-2">
            공공기관 공고를 매일 새벽에 모아 오고 있습니다. 기관별 조회 한도가 있어
            처음 전부 채우는 데 며칠이 걸립니다.
          </p>
          <p className="mt-2 text-ink-2">
            입력하신 정보({summary.profileLabel})는 그대로 보관되니, 잠시 후 다시
            확인해 주세요.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/sources"
              className="rounded-lg border-2 border-brand bg-bg px-5 py-3 font-semibold text-brand-dark no-underline"
            >
              어떤 곳에서 모으는지 보기
            </Link>
            <Link
              href="/onboarding"
              className="rounded-lg bg-brand px-5 py-3 font-semibold text-white no-underline"
            >
              입력 정보 수정하기
            </Link>
          </div>
        </div>
        <div className="mt-8">
          <Disclaimer />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ---------------- 매칭 요약 배너 ---------------- */}
      <div className="rounded-xl border border-line bg-brand-soft px-5 py-4">
        <h1 className="text-xl font-bold text-ink sm:text-2xl">
          {summary.profileLabel}{" "}
          <span className="text-brand-dark">{summary.total}건</span>
        </h1>
        {query && (
          <p className="mt-1 text-ink-2">
            찾으시는 것: <strong>&ldquo;{query}&rdquo;</strong>
          </p>
        )}
        {!query && (
          <p className="mt-1 text-ink-2">
            찾으시는 것을 입력하지 않으셔서, 대상이 되는 지원을 모두 보여드립니다.
          </p>
        )}
        <p className="mt-2 text-sm text-ink-3">
          응답 {data.tookMs}ms · 자유입력은 저장되지 않습니다.
        </p>
      </div>

      {aiAnswerStatus === "ok" && aiAnswer && (
        <section
          aria-labelledby="ai-answer-heading"
          className="mt-4 rounded-xl border border-brand bg-bg px-5 py-4"
        >
          <h2 id="ai-answer-heading" className="text-lg font-bold text-ink">
            검색 결과를 바탕으로 한 AI 안내
          </h2>
          <p className="mt-2 whitespace-pre-line text-ink-2">{aiAnswer}</p>
          <p className="mt-3 text-sm text-ink-3">
            자격 여부와 신청 조건은 반드시 해당 기관의 공고 원문에서 확인해 주세요.
          </p>
        </section>
      )}

      {aiAnswerStatus === "unavailable" && (
        <p role="status" className="mt-3 rounded-lg border border-warn bg-warn-soft px-4 py-2 text-sm text-ink-2">
          AI 안내를 불러오지 못했지만, 아래 매칭 결과는 정상적으로 확인할 수 있습니다.
        </p>
      )}

      {demoMode && (
        <p className="mt-3 rounded-lg border border-warn bg-warn-soft px-4 py-2 text-sm text-ink-2">
          <strong className="text-warn">데모 모드</strong> — 번들 예시 데이터로
          동작 중입니다.
        </p>
      )}

      {degraded && (
        <p className="mt-3 rounded-lg border border-warn bg-warn-soft px-4 py-2 text-sm text-ink-2">
          검색 엔진 일부에 문제가 있어 자격 조건만으로 결과를 구성했습니다.
        </p>
      )}

      {/* ---------------- §7.7 완화 안내 ---------------- */}
      {relaxationNotice && (
        <p
          role="status"
          className="mt-3 rounded-lg border border-brand bg-bg px-4 py-3 text-ink-2"
        >
          <strong className="text-brand-dark">안내</strong> · {relaxationNotice}
        </p>
      )}

      {/* ---------------- form 탭 ---------------- */}
      <nav aria-label="분류별 좁혀보기" className="mt-6">
        <p className="mb-2 text-sm text-ink-3">
          결과를 분류별로 좁혀볼 수 있습니다.
        </p>
        <ul className="flex flex-wrap gap-2">
          <TabButton
            active={tab === "all"}
            onClick={() => changeTab("all")}
            label="전체"
            count={FORMS.reduce((a, f) => a + summary.byForm[f], 0)}
          />
          {FORMS.map((f) => (
            <TabButton
              key={f}
              active={tab === f}
              onClick={() => changeTab(f)}
              label={FORM_LABEL[f]}
              count={summary.byForm[f]}
              disabled={summary.byForm[f] === 0}
            />
          ))}
        </ul>
      </nav>

      {/* 금소법 대응 (§8) — 대출·금융상품 탭에서는 비교·정보 제공임을 명시한다 */}
      {tab !== "all" && isFinancialProduct(tab) && (
        <div className="mt-4">
          <FinancialProductNotice />
        </div>
      )}

      {/* ---------------- 카드 리스트 ---------------- */}
      <section aria-label="매칭 결과" className="mt-6">
        {cards.length === 0 ? (
          <p className="rounded-xl border border-line bg-bg-soft p-8 text-center text-ink-2">
            이 분류에는 해당하는 지원이 없습니다. 다른 탭을 확인해 보세요.
          </p>
        ) : (
          <ul className="grid gap-4">
            {cards.map((c) => (
              <ProgramCard key={c.program.id} card={c} />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- 페이지네이션 ---------------- */}
      {nextCursor && (
        <nav aria-label="결과 페이지" className="mt-8 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={nextPage}
            className="rounded-lg border-2 border-line bg-bg px-4 py-2 font-semibold text-ink-2"
          >
            다음 →
          </button>
        </nav>
      )}

      {/* ---------------- 근접 탈락 (§7.6) ---------------- */}
      {nearMisses.length > 0 && (
        <section aria-labelledby="nearmiss-heading" className="mt-12">
          <h2 id="nearmiss-heading" className="text-xl font-bold text-ink">
            조건이 하나만 어긋난 지원{" "}
            <span className="text-ink-3">({nearMisses.length}건)</span>
          </h2>
          <p className="mt-1 text-ink-2">
            지금은 대상이 아니지만, 아래 조건 하나만 달라지면 신청할 수 있습니다.{" "}
            <Term name="근접탈락">근접탈락</Term>이라고 부릅니다.
          </p>
          <ul className="mt-4 grid gap-3">
            {nearMisses.map((n) => (
              <NearMissItem key={n.program.id} card={n} />
            ))}
          </ul>
        </section>
      )}

      <div className="mt-12 flex flex-wrap gap-3">
        <Link
          href="/onboarding"
          className="rounded-lg border-2 border-line bg-bg px-5 py-3 font-semibold text-ink-2 no-underline hover:bg-bg-sunken"
        >
          조건 다시 입력하기
        </Link>
      </div>

      <div className="mt-8">
        <Disclaimer />
      </div>
    </Shell>
  );
}

/**
 * subNav 는 결과가 실제로 있을 때만 띄운다 — 프로필이 없어 입력을 권하는 화면에서는
 * "조건 수정" 이 바로 아래 CTA 와 겹쳐 같은 말을 두 번 하게 된다.
 */
function Shell({
  children,
  subNav = true,
}: {
  children: React.ReactNode;
  subNav?: boolean;
}) {
  return (
    <>
      {subNav && (
      <SubNav title="내 결과">
        <Link
          href="/onboarding"
          className="press rounded-full bg-brand px-[1.375rem] py-[0.5rem] text-sm text-white no-underline hover:bg-brand-dark"
        >
          조건 수정
        </Link>
      </SubNav>
      )}
      <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8">{children}</div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        className={`rounded-lg border-2 px-4 py-2 font-semibold transition-colors ${
          active
            ? "border-brand bg-brand text-white"
            : "border-line bg-bg text-ink-2 hover:border-ink-3"
        } disabled:cursor-not-allowed disabled:border-line-soft disabled:bg-bg-soft disabled:text-ink-3`}
      >
        {label}{" "}
        <span className={active ? "text-white/80" : "text-ink-3"}>{count}</span>
      </button>
    </li>
  );
}
