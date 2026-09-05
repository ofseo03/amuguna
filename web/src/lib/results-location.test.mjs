import assert from "node:assert/strict";
import test from "node:test";
import { parseResultsLocation, resultsHref, safeResultsHref } from "./results-location.ts";

test("results location preserves tab, page, the full-results toggle, and the sort", () => {
  const location = { tab: "loan", page: 3, ignoreIntent: true, sort: "newest" };
  const href = resultsHref(location);
  assert.equal(href, "/results?form=loan&page=3&all=1&sort=newest");
  assert.deepEqual(parseResultsLocation(new URL(href, "http://localhost").searchParams), location);
  assert.equal(safeResultsHref(href), href);
  assert.equal(safeResultsHref("https://example.com/results"), "/results");
});

test("기본 정렬은 URL 에 적지 않고, 모르는 값은 기본값으로 되돌린다", () => {
  assert.equal(resultsHref({ tab: "all", page: 1, ignoreIntent: false, sort: "relevance" }), "/results");
  const params = (search) => new URL(search, "http://localhost").searchParams;
  assert.equal(parseResultsLocation(params("/results")).sort, "relevance");
  assert.equal(parseResultsLocation(params("/results?sort=deadline")).sort, "deadline");
  assert.equal(parseResultsLocation(params("/results?sort=oldest")).sort, "relevance");
  assert.equal(parseResultsLocation(params("/results?sort=아무거나")).sort, "relevance");
});
