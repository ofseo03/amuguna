"use client";

/**
 * 결과 화면 (SPEC §9 화면 3).
 * 매칭 요약 배너 + form 탭 + 카드 리스트 + 근접탈락 + 완화 안내 + 숫자 페이지네이션(15건).
 *
 * 자유입력은 sessionStorage 에서만 읽어 /api/match 로 보낸다 — URL 이나 서버에 남기지 않는다 (§8).
 *
 * **탭 전환은 서버를 부르지 않는다.** 커서 없는 첫 응답에 모든 탭의 1페이지가 함께 들어 있고
 * (`pages`), 그 뒤로도 (탭, 커서) 조합별로 응답을 캐시한다. 탭 6개를 훑는 평범한 조작이
 * 세션 한도(10회/분, §8)를 태우면 결과가 통째로 사라지던 것이 이 화면의 가장 흔한 고장이었다.
 *
 * 서버는 keyset 커서(score, id)만 알고 페이지 번호를 모른다. 그래서 탭별로 "n페이지의 커서" 를
 * 클라이언트가 기억한다 — 1페이지는 null, k+1 페이지는 k페이지 응답의 nextCursor. 아직 커서를 모르는
 * 먼 페이지를 누르면 아는 커서 중 가장 가까운 것에 `skipPages` 를 붙여 **요청 한 번**으로 간다 —
 * 한 페이지씩 걸어가면 클릭 한 번이 요청 여러 개가 되어 세션 한도를 태우고 도중에 끊긴다.
 *
 * **결과 안에서 찾기**(`sortQuery`)는 후보를 좁히지 않고 순서만 바꾼다 — 검색어에 걸린 건이 위로
 * 올라올 뿐 한 건도 사라지지 않는다. 임베딩을 쓰지 않으므로 온보딩의 "원하는 것" 과 다른 축이고,
 * 결과 건수·탭 건수·근접탈락 구성은 그대로다. 캐시와 커서는 검색어별로 따로 기억한다 — 같은 키에
 * 섞이면 정렬을 바꾼 뒤 2페이지가 옛 순서의 커서로 열린다.
 *
 * AI 안내는 카드와 따로 받는다(`/api/answer`). 한 응답에 묶으면 카드가 OpenRouter 를 기다린다.
 *
 * 오류는 화면을 갈아엎지 않는다. 이미 받아둔 결과가 있으면 카드는 그대로 두고 배너로만 얹는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NearMissItem, ProgramCard } from "@/components/ProgramCard";
import { Disclaimer, FinancialProductNotice, SubNav } from "@/components/SiteChrome";
import Term from "@/components/Term";
import StepTrail from "@/components/StepTrail";
import { FORMS, FORM_LABEL, isFinancialProduct } from "@/lib/forms";
import { QUERY_STORAGE_KEY } from "@/lib/client-keys";
import { MAX_SKIP_PAGES, MAX_SORT_QUERY_LEN } from "@/lib/validation";
import type { AiAnswerStatus, AnswerResponse, MatchPage, MatchResponse, MatchTab } from "@/lib/types";

type Payload = MatchResponse & { ok: true };
/** 화면에 그리는 한 단위 — 응답의 공통부(요약·근접탈락 등) + 지금 보고 있는 탭·페이지의 카드 */
type View = { payload: Payload; page: MatchPage };

/**
 * 같은 결과를 두 번 받아오지 않기 위한 키. 전체 보기 여부까지 넣어야 두 상태를 오갈 수 있다.
 * 결과 안에서 찾기(`sq`)도 키의 일부다 — 순서가 달라지면 페이지 커서도 다른 줄을 가리킨다.
 */
const tabKey = (all: boolean, t: MatchTab, sq: string) =>
  `${all ? "all-eligible" : "intent"}|${t}|${sq}`;
const cacheKey = (all: boolean, t: MatchTab, page: number, sq: string) =>
  `${tabKey(all, t, sq)}|p${page}`;

/** 탭 하나의 페이지 커서 기억. `cursors` 는 페이지 번호 → 그 페이지를 여는 커서 (1페이지는 null) */
type TabCursors = { cursors: Map<number, string | null>; lastPage: number | null };

/** n 이하에서 커서를 아는 가장 큰 페이지. 1페이지는 항상 안다. */
function nearestKnownPage(entry: TabCursors, n: number): number {
  let best = 1;
  for (const p of entry.cursors.keys()) if (p <= n && p > best) best = p;
  return best;
}

export default function ResultsPage() {
  const [tab, setTab] = useState<MatchTab>("all");
  const [page, setPage] = useState(1);
  /** 현재 탭에서 확인된 마지막 페이지 — 아직 모르면 null (렌더에서 ref 를 읽지 않으려고 state 로 복사) */
  const [lastPage, setLastPage] = useState<number | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; noProfile?: boolean } | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  /** 자유입력으로 좁힌 결과를 되돌려(§5 "전체 보기") 자격 대상 전체를 보고 있는가 */
  const [ignoreIntent, setIgnoreIntent] = useState(false);
  /** 결과 안에서 찾기 — 입력칸에 적힌 글자와, 실제로 서버에 보내 적용된 검색어를 나눠 둔다. */
  const [sortInput, setSortInput] = useState("");
  const [sortQuery, setSortQuery] = useState("");
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiAnswerStatus, setAiAnswerStatus] = useState<AiAnswerStatus>("not_requested");

  /** (전체 보기 여부, 탭, 페이지) → 응답. 첫 응답 하나가 모든 탭의 1페이지를 채운다. */
  const cache = useRef(new Map<string, View>());
  /**
   * 탭별 페이지 커서. 건너뛰기로 받은 페이지 사이는 비어 있을 수 있다(그래서 배열이 아니라 Map).
   * 마지막 페이지를 확인하면 lastPage 에 기록해 total 로 계산한 페이지 수보다 우선한다.
   */
  const pageCursors = useRef(new Map<string, TabCursors>());
  /** AI 안내는 결과 화면당 한 번만 요청한다 — 탭·페이지·전체 보기 이동은 같은 안내를 유지한다 */
  const answerRequested = useRef(false);
  /**
   * 마지막으로 보낸 요청의 순번. 응답이 도착했을 때 이 값과 다르면 그 사이 다른 탭·페이지를
   * 눌렀다는 뜻이므로 버린다 — 느린 응답이 늦게 와서 새 탭 위에 옛 카드를 그리지 않게 한다.
   */
  const reqSeq = useRef(0);

  type Outcome =
    | { kind: "ok"; view: View }
    | { kind: "error"; message: string; noProfile: boolean };

  /**
   * 순수 fetch — 상태를 건드리지 않고 결과만 돌려준다.
   * 상태 갱신은 전부 호출부의 .then 안에서 일어나므로 effect 본문에서 동기 setState 가 없다.
   *
   * `page` 는 이 요청이 여는 페이지 번호(= 커서의 페이지 + skipPages). 캐시 키로만 쓴다.
   * 응답에 담겨 온 다른 탭의 1페이지도 함께 캐시에 넣는다. 그래서 탭을 눌러도 요청이 나가지 않는다.
   */
  const fetchMatch = useCallback(
    (
      all: boolean,
      nextTab: MatchTab,
      page: number,
      nextCursor: string | null,
      skipPages: number,
      q: string | null,
      sq: string,
    ): Promise<Outcome> => {
      const hit = cache.current.get(cacheKey(all, nextTab, page, sq));
      if (hit) return Promise.resolve({ kind: "ok", view: hit });

      return fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: q,
          form: nextTab,
          cursor: nextCursor,
          skipPages: skipPages > 0 ? skipPages : undefined,
          ignoreIntent: all,
          sortQuery: sq || undefined,
        }),
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
          const payload = body as Payload;
          for (const [t, p] of Object.entries(payload.pages)) {
            // 요청한 탭만 요청한 페이지다. 곁들여 온 다른 탭은 언제나 1페이지다.
            const key = cacheKey(all, t as MatchTab, t === nextTab ? page : 1, sq);
            cache.current.set(key, { payload, page: p as MatchPage });
          }
          const requested = payload.pages[nextTab];
          if (!requested) {
            // 건수 0인 탭은 서버가 아예 담지 않는다 — 빈 페이지로 그린다.
            return { kind: "ok" as const, view: { payload, page: { cards: [], nextCursor: null } } };
          }
          return { kind: "ok" as const, view: { payload, page: requested } };
        })
        .catch(() => ({
          kind: "error" as const,
          message: "네트워크 오류가 발생했습니다.",
          noProfile: false,
        }));
    },
    [],
  );

  /**
   * 오류는 이미 받아둔 결과를 지우지 않는다.
   *
   * 429 한 번에 보고 있던 카드와 탭이 전부 사라지면 사용자는 결과를 잃는다. `view` 는 그대로 두고
   * 배너로만 알린다 — 프로필이 없는 경우(no_profile)만 보여줄 결과 자체가 없으므로 화면을 바꾼다.
   */
  const apply = useCallback((outcome: Outcome, q: string | null) => {
    setQuery(q);
    if (outcome.kind === "ok") {
      setView(outcome.view);
      setError(null);
    } else {
      setError({ message: outcome.message, noProfile: outcome.noProfile });
    }
    setLoading(false);
  }, []);

  const cursorsFor = useCallback((all: boolean, t: MatchTab, sq: string): TabCursors => {
    const key = tabKey(all, t, sq);
    let entry = pageCursors.current.get(key);
    if (!entry) {
      entry = { cursors: new Map([[1, null]]), lastPage: null };
      pageCursors.current.set(key, entry);
    }
    return entry;
  }, []);

  /**
   * n 페이지 응답을 받았을 때 n+1 페이지 커서(또는 마지막 페이지 여부)를 기록한다.
   *
   * 여기서는 화면 상태(lastPage)를 건드리지 않는다 — 버린 요청(다른 탭을 이미 눌렀다)의
   * 늦은 응답이 지금 보고 있는 탭의 페이지 수를 잘라 버렸었다. 캐시·커서 기록은 어느 탭의
   * 것이든 유효하므로 남기고, 화면 반영은 호출부가 순번을 확인한 뒤에 한다.
   */
  const rememberPage = useCallback(
    (all: boolean, t: MatchTab, n: number, view: View, sq: string) => {
      const entry = cursorsFor(all, t, sq);
      if (view.page.nextCursor) {
        entry.cursors.set(n + 1, view.page.nextCursor);
      } else {
        entry.lastPage = n;
      }
    },
    [cursorsFor],
  );

  /**
   * 질의가 있는 최초 검색의 상위 5건으로 AI 안내를 따로 받아온다 — 카드는 이미 떠 있다.
   * 결과 화면당 한 번이고, 실패해도 카드는 그대로다 (unavailable 안내만 붙는다).
   */
  const requestAnswer = useCallback((q: string | null, view: View) => {
    if (answerRequested.current) return;
    const programIds = view.page.cards.slice(0, 5).map((c) => c.program.id);
    if (!q?.trim() || programIds.length === 0) return;
    answerRequested.current = true;
    setAiAnswerStatus("pending");
    void fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q, programIds }),
    })
      .then(async (res) => {
        const body = (await res.json()) as Partial<AnswerResponse> & { ok?: boolean };
        if (!res.ok || !body.ok || !body.aiAnswerStatus) throw new Error("answer failed");
        setAiAnswer(body.aiAnswer ?? null);
        setAiAnswerStatus(body.aiAnswerStatus);
      })
      .catch(() => {
        setAiAnswer(null);
        setAiAnswerStatus("unavailable");
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 자유입력은 URL 이 아니라 탭 메모리에서만 읽는다 (§8 — 서버·주소창에 남기지 않는다)
    const q = window.sessionStorage.getItem(QUERY_STORAGE_KEY);
    const seq = ++reqSeq.current;
    void fetchMatch(false, "all", 1, null, 0, q, "").then((o) => {
      if (o.kind === "ok") rememberPage(false, "all", 1, o.view, "");
      if (cancelled || seq !== reqSeq.current) return;
      if (o.kind === "ok") {
        setLastPage(cursorsFor(false, "all", "").lastPage);
        requestAnswer(q, o.view);
      }
      apply(o, q);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchMatch, apply, rememberPage, cursorsFor, requestAnswer]);

  /**
   * (전체 보기 여부, t 탭)의 n 페이지로 이동한다.
   *
   * 커서를 모르는 페이지면 아는 커서 중 n 에 가장 가까운 것에서 `skipPages` 만큼 건너뛰어
   * **요청 한 번**으로 간다. 서버 상한(MAX_SKIP_PAGES)보다 먼 페이지만 두 번 이상 왕복한다.
   * total 로 계산한 페이지 수가 실제보다 커서 빈 페이지가 오면 한 페이지 앞으로 물러선다.
   * 1페이지는 첫 응답이 이미 캐시에 넣어 두었으므로 요청이 나가지 않는다.
   */
  async function loadPage(all: boolean, t: MatchTab, n: number, sq: string = sortQuery) {
    setLoading(true);
    const seq = ++reqSeq.current;
    const entry = cursorsFor(all, t, sq);
    let target = Math.max(1, n);
    let current = 1;
    let outcome: Outcome;
    for (;;) {
      const from = nearestKnownPage(entry, target);
      const skip = Math.min(target - from, MAX_SKIP_PAGES);
      current = from + skip;
      outcome = await fetchMatch(all, t, current, entry.cursors.get(from) ?? null, skip, query, sq);
      if (outcome.kind !== "ok") break;
      rememberPage(all, t, current, outcome.view, sq);
      if (seq !== reqSeq.current) return;
      if (outcome.view.page.cards.length === 0 && current > 1) {
        entry.lastPage = current - 1;
        target = current - 1;
        continue;
      }
      if (current >= target || !outcome.view.page.nextCursor) break;
    }
    if (seq !== reqSeq.current) return;
    // 어디를 보고 있는지는 실제로 받아온 뒤에만 움직인다 — 실패했는데 탭·페이지 표시만
    // 옮겨가면 화면에 남은 카드와 어긋난다. 정렬 검색어도 마찬가지다.
    if (outcome.kind === "ok") {
      setIgnoreIntent(all);
      setTab(t);
      setPage(current);
      setSortQuery(sq);
      setLastPage(entry.lastPage);
      // 첫 로드가 실패해 "다시 시도" 로 들어온 경우 — 안내도 이제 받는다.
      if (!all && t === "all" && current === 1) requestAnswer(query, outcome.view);
    }
    apply(outcome, query);
  }

  function changeTab(t: MatchTab) {
    void loadPage(ignoreIntent, t, 1);
  }

  function goToPage(n: number) {
    if (n === page) return;
    void loadPage(ignoreIntent, tab, n);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** §5 자유입력이 숨긴 결과를 펴고 접는다. 두 상태 모두 캐시되므로 오갈 때 요청은 한 번뿐이다. */
  function toggleIgnoreIntent() {
    void loadPage(!ignoreIntent, "all", 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /**
   * 결과 안에서 찾기 — 순서만 바꾸므로 탭과 전체 보기 상태는 그대로 두고 1페이지로만 돌아간다.
   * 매 글자마다 보내지 않는다: 요청 한 번이 세션 한도(§8, 10회/분) 한 칸이라 제출할 때만 보낸다.
   */
  function applySort(next: string) {
    const trimmed = next.trim().slice(0, MAX_SORT_QUERY_LEN);
    if (trimmed === sortQuery) return;
    setSortInput(trimmed);
    void loadPage(ignoreIntent, tab, 1, trimmed);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** 지금 탭에서 보여줄 페이지 수 — total 기준이되, 마지막 페이지를 확인했다면 그 값을 쓴다. */
  function pageCount(total: number, pageSize: number) {
    const byTotal = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));
    return lastPage === null ? byTotal : Math.min(byTotal, Math.max(lastPage, page));
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

  // 보여줄 결과가 아직 없을 때만 오류가 화면 전체를 차지한다.
  if (error && !view) {
    return (
      <Shell>
        <ErrorNotice message={error.message} onRetry={() => void loadPage(ignoreIntent, tab, page)} />
      </Shell>
    );
  }

  if (loading && !view) {
    return (
      <Shell>
        <p aria-live="polite" className="py-16 text-center text-lg text-ink-2">
          내게 맞는 지원을 찾고 있습니다…
        </p>
      </Shell>
    );
  }

  if (!view) return null;

  const data = view.payload;
  const cards = view.page.cards;
  const { summary, nearMisses, relaxationNotice, pageSize, sortApplied, demoMode, degraded } = data;
  /** 지금 보고 있는 페이지에서 검색어에 실제로 걸린 건수 — 정렬이 무엇을 했는지 눈으로 확인시킨다 */
  const sortMatched = sortApplied ? cards.filter((c) => c.keywordScore > 0).length : 0;
  const tabTotal = tab === "all" ? summary.total : summary.byForm[tab];
  const totalPages = pageCount(tabTotal, pageSize);

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
      {/* 결과를 지우지 않고 얹기만 하는 오류 배너 — 429 한 번에 카드가 사라지지 않게 한다 */}
      {error && (
        <div className="mb-4">
          <ErrorNotice
            message={error.message}
            onRetry={() => void loadPage(ignoreIntent, tab, page)}
          />
        </div>
      )}

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

      {/*
        자유입력이 결과를 얼마나 깎았는지 알리고 되돌릴 수 있게 한다 (§5).
        대상인데 몰라서 못 받는 것을 없애자는 서비스가, 문장 한 줄 때문에 대상인 것을
        조용히 숨기면 안 된다. 몇 건이 빠졌는지 말하고, 한 번에 전부 펼 수 있게 둔다.
      */}
      {data.intentHiddenCount > 0 && !data.intentIgnored && (
        <IntentFilterNotice onToggle={toggleIgnoreIntent} busy={loading}>
          찾으시는 것과 관련이 적어{" "}
          <strong className="text-ink">{data.intentHiddenCount}건</strong>을 숨겼습니다.
          대상이 되는 지원은 이보다 많습니다.
        </IntentFilterNotice>
      )}
      {data.intentIgnored && (
        <IntentFilterNotice onToggle={toggleIgnoreIntent} busy={loading} label="관련된 것만 보기">
          찾으시는 것과 상관없이 <strong className="text-ink">대상이 되는 지원 전체</strong>를
          보고 있습니다.
        </IntentFilterNotice>
      )}

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

      {aiAnswerStatus === "pending" && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-line bg-bg-soft px-4 py-2 text-sm text-ink-2">
          검색 결과를 바탕으로 AI 안내를 준비하고 있습니다…
        </p>
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

      {/* ---------------- 결과 안에서 찾기 (정렬) ---------------- */}
      <ResultSearch
        value={sortInput}
        applied={sortQuery}
        active={sortApplied}
        matched={sortMatched}
        shown={cards.length}
        page={page}
        busy={loading}
        onChange={setSortInput}
        onSubmit={() => applySort(sortInput)}
        onClear={() => applySort("")}
      />

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
            count={summary.total}
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

      {/* ---------------- 페이지네이션 (15건 단위, 숫자) ---------------- */}
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} busy={loading} onSelect={goToPage} />
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

/**
 * 결과 안에서 찾기 (결과 화면 정렬).
 *
 * 탭이 "어떤 종류인가" 로 좁힌다면 이건 "무슨 말이 들어 있나" 로 줄을 다시 세운다. 임베딩이
 * 아니라 카드에 실제로 보이는 글자(제목·요약·기관명·지원금액 문구)를 대조하므로, 왜 이 순서인지
 * 사용자가 화면에서 그대로 확인할 수 있다 (`src/lib/keyword-sort.ts`).
 *
 * **거르지 않고 순서만 바꾼다.** 대상인데 몰라서 못 받는 것을 없애자는 서비스가 낱말 하나로
 * 대상인 것을 숨기면 안 된다 (§5). 그래서 안내 문구도 "숨기지 않는다"를 먼저 말한다.
 *
 * 입력 중에는 요청을 보내지 않는다 — 한 글자에 한 번씩 나가면 세션 한도(§8, 10회/분)를 태워
 * 결과가 통째로 사라진다. 제출(Enter·버튼)에서만 한 번 나간다.
 */
function ResultSearch({
  value,
  applied,
  active,
  matched,
  shown,
  page,
  busy,
  onChange,
  onSubmit,
  onClear,
}: {
  value: string;
  /** 실제로 적용되어 지금 순서를 만든 검색어 (없으면 빈 문자열) */
  applied: string;
  /** 서버가 낱말을 실제로 뽑아 정렬에 썼는가 — 문장부호만 넣으면 false 다 */
  active: boolean;
  matched: number;
  shown: number;
  /** 지금 보고 있는 페이지 번호 — 걸린 게 없을 때 할 수 있는 말이 페이지마다 다르다 */
  page: number;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}) {
  return (
    <section
      aria-labelledby="result-search-heading"
      className="mt-6 rounded-xl border border-line bg-bg-soft px-5 py-4"
    >
      <h2 id="result-search-heading" className="text-base font-bold text-ink">
        결과 안에서 찾기
      </h2>
      <p id="result-search-help" className="mt-1 text-sm text-ink-2">
        낱말을 넣으면 제목·요약·기관명·지원금액 문구에 그 말이 들어 있는 지원을 위로 올립니다.{" "}
        <strong className="text-ink">결과를 숨기지 않고 순서만 바꿉니다.</strong>
      </p>
      <form
        role="search"
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="result-search" className="text-sm font-semibold text-ink-2">
          찾을 낱말
        </label>
        <input
          id="result-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={MAX_SORT_QUERY_LEN}
          placeholder="예: 전세 청년"
          aria-describedby="result-search-help"
          className="min-w-[12rem] flex-1 rounded-lg border-2 border-line bg-bg px-4 py-2 text-ink placeholder:text-ink-3 focus:border-brand"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          정렬
        </button>
        {applied !== "" && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="rounded-lg border-2 border-line bg-bg px-4 py-2 font-semibold text-ink-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            지우기
          </button>
        )}
      </form>
      {applied !== "" && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-ink-2">
          {/*
            걸린 건이 위로 올라오므로 1페이지에 하나도 없으면 어디에도 없다 — 그때는 "순서를
            바꿨다"고 말하지 않는다(실제로 달라진 게 없다). 뒤쪽 페이지라면 앞 페이지에 있다고
            일러 준다. 없는 곳을 뒤지게 두지 않는다.
          */}
          {active && matched > 0 ? (
            <>
              <strong className="text-ink">&ldquo;{applied}&rdquo;</strong> 기준으로 순서를
              바꿨습니다 — 이 페이지의 {shown}건 중{" "}
              <strong className="text-ink">{matched}건</strong>에 이 말이 들어 있습니다.
            </>
          ) : active && page > 1 ? (
            <>
              <strong className="text-ink">&ldquo;{applied}&rdquo;</strong> 이(가) 들어 있는
              지원은 앞 페이지에 모여 있습니다.
            </>
          ) : active ? (
            <>
              <strong className="text-ink">&ldquo;{applied}&rdquo;</strong> 이(가) 들어 있는
              지원이 없어 원래 순서 그대로 보여드립니다.
            </>
          ) : (
            <>
              <strong className="text-ink">&ldquo;{applied}&rdquo;</strong> 에서 찾을 낱말을
              알아내지 못해 원래 순서를 그대로 두었습니다.
            </>
          )}
        </p>
      )}
    </section>
  );
}

/** 페이지 번호 창의 크기 — 현재 페이지를 가운데 두고 최대 5개를 보여준다. */
const PAGE_WINDOW = 5;

function Pagination({
  page,
  totalPages,
  busy,
  onSelect,
}: {
  page: number;
  totalPages: number;
  busy: boolean;
  onSelect: (n: number) => void;
}) {
  const start = Math.max(1, Math.min(page - Math.floor(PAGE_WINDOW / 2), totalPages - PAGE_WINDOW + 1));
  const end = Math.min(totalPages, start + PAGE_WINDOW - 1);
  const numbers: number[] = [];
  for (let n = start; n <= end; n += 1) numbers.push(n);

  return (
    <nav aria-label="결과 페이지" className="mt-8">
      <ol className="flex flex-wrap items-center justify-center gap-2">
        {start > 1 && (
          <li>
            <PageButton n={1} active={false} busy={busy} onSelect={onSelect} />
          </li>
        )}
        {start > 2 && (
          <li aria-hidden="true" className="px-1 text-ink-3">
            …
          </li>
        )}
        {numbers.map((n) => (
          <li key={n}>
            <PageButton n={n} active={n === page} busy={busy} onSelect={onSelect} />
          </li>
        ))}
        {end < totalPages - 1 && (
          <li aria-hidden="true" className="px-1 text-ink-3">
            …
          </li>
        )}
        {end < totalPages && (
          <li>
            <PageButton n={totalPages} active={false} busy={busy} onSelect={onSelect} />
          </li>
        )}
      </ol>
      <p className="mt-2 text-center text-sm text-ink-3">
        {page} / {totalPages} 페이지
      </p>
    </nav>
  );
}

function PageButton({
  n,
  active,
  busy,
  onSelect,
}: {
  n: number;
  active: boolean;
  busy: boolean;
  onSelect: (n: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(n)}
      disabled={busy}
      aria-current={active ? "page" : undefined}
      aria-label={`${n}페이지`}
      className={`min-w-[2.75rem] rounded-lg border-2 px-3 py-2 font-semibold transition-colors ${
        active
          ? "border-brand bg-brand text-white"
          : "border-line bg-bg text-ink-2 hover:border-ink-3"
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {n}
    </button>
  );
}

/**
 * 오류 알림. 결과 위에 배너로 얹기도 하고, 보여줄 결과가 없을 때는 화면 전체를 차지하기도 한다.
 */
function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-danger bg-danger-soft p-6">
      <h2 className="font-bold text-danger">{message}</h2>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg border-2 border-danger bg-bg px-5 py-2 font-semibold text-danger"
      >
        다시 시도
      </button>
    </div>
  );
}

/** 자유입력이 숨긴 결과를 알리고 펴고 접는 줄 (§5) */
function IntentFilterNotice({
  children,
  onToggle,
  busy,
  label = "전체 보기",
}: {
  children: React.ReactNode;
  onToggle: () => void;
  busy: boolean;
  label?: string;
}) {
  return (
    <p
      role="status"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand bg-bg px-4 py-3 text-ink-2"
    >
      <span>{children}</span>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className="rounded-lg border-2 border-brand bg-bg px-4 py-1.5 font-semibold text-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {label}
      </button>
    </p>
  );
}
