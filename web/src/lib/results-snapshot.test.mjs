import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_TTL_MS,
  clearSnapshot,
  isUsableSnapshot,
  readScroll,
  readSnapshot,
  updateSnapshotAnswer,
  writeScroll,
  writeSnapshot,
} from "./results-snapshot.ts";

/** sessionStorage 대역 — 이 모듈은 저장소를 주입받으므로 DOM 없이 그대로 검증한다 */
function fakeStorage({ throwOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const SNAP = {
  v: 1,
  savedAt: 1_000_000,
  q: "보증금 올려달래서 대출 알아봐요",
  ignoreIntent: false,
  sort: "relevance",
  payload: { ok: true, pages: { all: { cards: [], nextCursor: null } } },
  aiAnswer: null,
  aiAnswerStatus: "not_requested",
};
const WANT = { q: SNAP.q, ignoreIntent: false, sort: "relevance", page: 1 };

test("snapshot round-trips through storage", () => {
  const store = fakeStorage();
  assert.equal(writeSnapshot(SNAP, store), true);
  assert.deepEqual(readSnapshot(store), SNAP);
});

test("snapshot is used only for the same search on page 1", () => {
  const now = SNAP.savedAt + 1_000;
  assert.equal(isUsableSnapshot(SNAP, WANT, now), true);
  // 자유입력 · 전체보기 · 정렬 축이 하나라도 다르면 다시 검색한다
  assert.equal(isUsableSnapshot(SNAP, { ...WANT, q: "다른 문장" }, now), false);
  assert.equal(isUsableSnapshot(SNAP, { ...WANT, q: null }, now), false);
  assert.equal(isUsableSnapshot(SNAP, { ...WANT, ignoreIntent: true }, now), false);
  assert.equal(isUsableSnapshot(SNAP, { ...WANT, sort: "recent" }, now), false);
  // 2페이지 이후는 저장하지 않으므로 되살리지도 않는다
  assert.equal(isUsableSnapshot(SNAP, { ...WANT, page: 2 }, now), false);
  assert.equal(isUsableSnapshot(null, WANT, now), false);
});

test("snapshot expires after the TTL", () => {
  assert.equal(isUsableSnapshot(SNAP, WANT, SNAP.savedAt + SNAPSHOT_TTL_MS), true);
  assert.equal(isUsableSnapshot(SNAP, WANT, SNAP.savedAt + SNAPSHOT_TTL_MS + 1), false);
});

test("oversized or unwritable storage fails quietly", () => {
  const store = fakeStorage();
  const huge = {
    ...SNAP,
    payload: { ok: true, pages: { all: { cards: ["x".repeat(MAX_SNAPSHOT_BYTES)] } } },
  };
  assert.equal(writeSnapshot(huge, store), false, "상한을 넘으면 저장하지 않는다");
  assert.equal(readSnapshot(store), null);
  // 저장소가 막혀 있어도 예외가 화면까지 올라가지 않는다
  assert.equal(writeSnapshot(SNAP, fakeStorage({ throwOnSet: true })), false);
  assert.equal(readSnapshot(null), null);
});

test("corrupt json reads as no snapshot", () => {
  const store = fakeStorage();
  store.setItem("amuguna.results", "{not json");
  assert.equal(readSnapshot(store), null);
});

test("late AI answer is folded into the stored snapshot", () => {
  const store = fakeStorage();
  writeSnapshot(SNAP, store);
  updateSnapshotAnswer("안내 문장", "ok", store);
  const after = readSnapshot(store);
  assert.equal(after.aiAnswer, "안내 문장");
  assert.equal(after.aiAnswerStatus, "ok");
  // 저장된 스냅샷이 없으면 아무 일도 하지 않는다
  const empty = fakeStorage();
  updateSnapshotAnswer("안내", "ok", empty);
  assert.equal(readSnapshot(empty), null);
});

test("scroll position is kept per results href", () => {
  const store = fakeStorage();
  writeScroll({ href: "/results?form=loan", y: 1200 }, store);
  assert.deepEqual(readScroll(store), { href: "/results?form=loan", y: 1200 });
  store.setItem("amuguna.results.scroll", JSON.stringify({ href: 3, y: "x" }));
  assert.equal(readScroll(store), null, "형식이 어긋나면 복원하지 않는다");
});

test("clearing drops both the snapshot and the scroll position", () => {
  const store = fakeStorage();
  writeSnapshot(SNAP, store);
  writeScroll({ href: "/results", y: 40 }, store);
  clearSnapshot(store);
  assert.equal(readSnapshot(store), null);
  assert.equal(readScroll(store), null);
  assert.equal(store.size(), 0);
});
