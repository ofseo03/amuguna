import { FORMS } from "./forms";
import { DEFAULT_RESULT_SORT, isResultSort } from "./result-sort";
import type { MatchTab, ResultSort } from "./types";

export interface ResultsLocation {
  tab: MatchTab;
  page: number;
  ignoreIntent: boolean;
  /**
   * 결과 화면 정렬 축. 자유입력과 달리 **URL 에 남긴다** — 사용자가 친 글자가 아니라
   * 화면의 버튼 셋 중 하나이므로 주소창·공유 링크에 남아도 새어 나갈 개인정보가 없다.
   * 덕분에 상세를 봤다 돌아오거나 새로고침해도 보고 있던 순서가 그대로 살아난다.
   */
  sort: ResultSort;
}

export function parseResultsLocation(params: URLSearchParams): ResultsLocation {
  const form = params.get("form");
  const page = Number(params.get("page") ?? 1);
  const sort = params.get("sort");
  return {
    tab: form && (FORMS as string[]).includes(form) ? (form as MatchTab) : "all",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    ignoreIntent: params.get("all") === "1",
    sort: isResultSort(sort) ? sort : DEFAULT_RESULT_SORT,
  };
}

export function resultsHref({ tab, page, ignoreIntent, sort }: ResultsLocation): string {
  const params = new URLSearchParams();
  if (tab !== "all") params.set("form", tab);
  if (page > 1) params.set("page", String(page));
  if (ignoreIntent) params.set("all", "1");
  if (sort !== DEFAULT_RESULT_SORT) params.set("sort", sort);
  const query = params.toString();
  return query ? `/results?${query}` : "/results";
}

export function safeResultsHref(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/results";
  try {
    const url = new URL(value, "http://localhost");
    return url.origin === "http://localhost" && url.pathname === "/results"
      ? `${url.pathname}${url.search}`
      : "/results";
  } catch {
    return "/results";
  }
}
