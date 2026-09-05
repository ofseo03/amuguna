/**
 * 결과 화면 정렬 — 이미 뽑아 놓은 결과의 **순서만** 바꾼다.
 *
 * 온보딩의 "원하는 것" 한 줄은 임베딩으로 집합 B 를 정의한다 — 결과를 좁히는 장치다.
 * 이 모듈은 그것과 다르다. 후보 집합에는 손대지 않으므로 총 건수·탭 건수·근접탈락 구성은
 * 어떤 정렬에서도 같다. 바뀌는 것은 줄 세우는 순서뿐이다.
 *
 * 축은 셋이다.
 *  - `relevance` — 유효한 질문은 관련도순, 없으면 유사도를 제외한 추천순.
 *  - `newest`    (최신순)   — 공고일이 늦은 것부터
 *  - `oldest`    (오래된순) — 공고일이 이른 것부터
 *
 * **왜 낱말 입력이 아니라 버튼인가.** 결과 화면에서 사람이 고르고 싶은 건 대개 "무슨 말이
 * 들어 있나"가 아니라 "새 공고부터 보자" 같은 **한 가지 축**이다. 낱말을 치게 하면 무엇을
 * 쳐야 할지부터 정해야 하고, 오타 하나가 순서를 통째로 바꾼다. 버튼 셋은 고를 것이 눈에
 * 보이고, 지금 어느 순서로 보고 있는지도 화면에 그대로 남는다.
 *
 * **점수 하나로 표현한다.** 서버는 keyset 커서 `(score, id)` 로만 페이지를 넘기고 커서는
 * 0~1 만 받는다(`validateCursor`). 그래서 날짜 정렬도 별도 정렬 키를 만들지 않고 같은
 * `sort_score` 안에 접어 넣는다 — `ORDER BY sort_score DESC, id ASC` 한 줄이 세 축을 모두
 * 처리하고, 페이지 커서·건너뛰기·캐시가 축과 무관하게 그대로 동작한다.
 *
 * 이 파일의 공식은 `db/migrations/0016_query_aware_ranking.sql` 의 `match_program_page()` 와
 * **완전히 같아야 한다.** 데모 모드는 여기서, DB 모드는 SQL 에서 같은 순서를 내야 한다.
 */
import { kstDate, toDateString } from "./eligibility";
import type { Program, ResultSort } from "./types";

export const RESULT_SORTS: readonly ResultSort[] = ["relevance", "newest", "oldest"];

/** 기본 정렬은 실제 사용한 질문에 따라 관련도순 또는 추천순이다. */
export const DEFAULT_RESULT_SORT: ResultSort = "relevance";

export const RESULT_SORT_LABEL: Record<ResultSort, string> = {
  relevance: "추천순",
  newest: "최신순",
  oldest: "오래된순",
};

/** 버튼 밑에 붙는 한 줄 설명 — 무엇을 기준으로 세운 줄인지 말해 준다. */
export const RESULT_SORT_HINT: Record<ResultSort, string> = {
  relevance: "조건 구체성·지역·금액·마감을 각각 25%씩 반영합니다.",
  newest: "공고일이 늦은 것부터 보여드립니다.",
  oldest: "공고일이 이른 것부터 보여드립니다.",
};

export function isResultSort(value: unknown): value is ResultSort {
  return typeof value === "string" && (RESULT_SORTS as readonly string[]).includes(value);
}

export function resultSortLabel(sort: ResultSort, usesSimilarity: boolean): string {
  return sort === "relevance" && usesSimilarity ? "관련도순" : RESULT_SORT_LABEL[sort];
}

export function resultSortHint(sort: ResultSort, usesSimilarity: boolean): string {
  return sort === "relevance" && usesSimilarity
    ? "입력한 내용과 의미가 가까운 것부터 보여드립니다."
    : RESULT_SORT_HINT[sort];
}

/**
 * 공고일을 0~1 로 펴는 창. 1970-01-01 부터 40000일(약 2079년)까지다.
 *
 * 하루의 간격이 `1/40000 = 0.000025` 로 일정해, 아래 tie-break 항(최대 0.00001)보다 항상 크다.
 * 창을 벗어난 날짜는 양 끝으로 붙는다 — 그런 공고는 어차피 노출 대상이 아니다.
 */
export const RECENCY_SPAN_DAYS = 40_000;

/**
 * 날짜가 먼저, §7.4 스코어는 **같은 날짜일 때만** 순서를 정한다.
 *
 * 두 항의 합이 1 을 넘지 않아야 keyset 커서 검증(0~1)이 그대로 유효하다. 그래서 1 을 둘로
 * 나눠 쓴다: 하루 차이가 만드는 `0.99999 × 0.000025 = 0.0000249975` 는 §7.4 스코어가 만들 수
 * 있는 최대 차이 `0.00001 × 1` 보다 크므로, 날짜가 다르면 언제나 날짜가 이긴다.
 */
export const RECENCY_WEIGHT = 0.99999;
export const BASE_TIEBREAK = 0.00001;

/** SQL 의 `round(x, 12)` 와 같은 눈금 — 두 백엔드가 같은 값을 내도록 맞춘다. */
function round12(x: number): number {
  return Math.round(x * 1e12) / 1e12;
}

const DAY_MS = 86_400_000;

/**
 * 이 공고의 "공고일" — 접수 시작일, 없으면 수집일(KST 달력 날짜).
 *
 * `starts_at` 은 공고문이 말하는 접수 시작일이라 사람이 생각하는 "언제 나온 공고인가"에 가장
 * 가깝다. 상시 접수처럼 시작일이 없는 건은 우리가 그 공고를 처음 본 날(`fetched_at`)로 대신한다
 * — 정확한 게시일은 아니지만, 날짜가 아예 없어 전부 같은 자리에 몰리는 것보다는 낫다.
 */
export function recencyDate(program: Program): string | null {
  const started = toDateString(program.starts_at);
  if (started) return started;
  if (!program.fetched_at) return null;
  const fetched = new Date(program.fetched_at);
  return Number.isNaN(fetched.getTime()) ? null : kstDate(fetched);
}

/** 공고일을 0~1 로. 날짜를 모르면 창의 맨 앞(= 가장 오래된 것)으로 둔다. */
export function recencyScore(program: Program): number {
  const date = recencyDate(program);
  if (date === null) return 0;
  const days = Date.parse(`${date}T00:00:00Z`) / DAY_MS;
  if (!Number.isFinite(days)) return 0;
  return Math.min(1, Math.max(0, days / RECENCY_SPAN_DAYS));
}

/**
 * 최종 정렬 점수 (0~1). 질문이 있으면 순수 유사도, 없으면 추천 점수를 쓴다.
 *
 * 두 날짜 정렬은 방향만 반대다: 최신순은 공고일을 그대로, 오래된순은 뒤집어 쓴다. 어느 쪽이든
 * `ORDER BY sort_score DESC, id ASC` 한 줄로 정렬되므로 페이지 커서가 그대로 유효하다.
 */
export function resultSortScore(base: number, program: Program, sort: ResultSort, similarity: number | null = null): number {
  if (sort !== "newest" && sort !== "oldest") {
    // 음수 유사도도 순서를 보존하면서 기존 0~1 커서에 담는다.
    return round12(similarity === null ? base : (Math.max(-1, Math.min(1, similarity)) + 1) / 2);
  }
  const recency = recencyScore(program);
  const oriented = sort === "oldest" ? 1 - recency : recency;
  return round12(RECENCY_WEIGHT * oriented + BASE_TIEBREAK * base);
}
