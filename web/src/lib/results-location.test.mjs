import assert from "node:assert/strict";
import test from "node:test";
import { parseResultsLocation, resultsHref, safeResultsHref } from "./results-location.ts";

test("results location preserves tab, page, and the full-results toggle", () => {
  const location = { tab: "loan", page: 3, ignoreIntent: true };
  const href = resultsHref(location);
  assert.equal(href, "/results?form=loan&page=3&all=1");
  assert.deepEqual(parseResultsLocation(new URL(href, "http://localhost").searchParams), location);
  assert.equal(safeResultsHref(href), href);
  assert.equal(safeResultsHref("https://example.com/results"), "/results");
});
