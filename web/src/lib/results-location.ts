import { FORMS } from "./forms";
import type { MatchTab } from "./types";

export interface ResultsLocation {
  tab: MatchTab;
  page: number;
  ignoreIntent: boolean;
}

export function parseResultsLocation(params: URLSearchParams): ResultsLocation {
  const form = params.get("form");
  const page = Number(params.get("page") ?? 1);
  return {
    tab: form && (FORMS as string[]).includes(form) ? (form as MatchTab) : "all",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    ignoreIntent: params.get("all") === "1",
  };
}

export function resultsHref({ tab, page, ignoreIntent }: ResultsLocation): string {
  const params = new URLSearchParams();
  if (tab !== "all") params.set("form", tab);
  if (page > 1) params.set("page", String(page));
  if (ignoreIntent) params.set("all", "1");
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
