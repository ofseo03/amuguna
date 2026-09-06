/**
 * 결과 화면 스냅샷 — 뒤로가기가 재검색이 되지 않게 한다 (SPEC §8 세션 한도).
 *
 * **왜 필요한가.** 결과 화면의 캐시는 컴포넌트 메모리(`useRef`)에만 있다. 카드를 눌러 상세로
 * 갔다가 뒤로 오면 화면이 새로 뜨면서 캐시가 비어 있고, 그래서 `/api/match` 를 매번 다시
 * 부른다. 세션 한도는 분당 10회다 — **카드 한 장을 확인하는 값이 검색 한 번과 같다.**
 * 페르소나 80명 점검에서 카드를 9장 열어보고 돌아온 열 번째에 429 가 났고, 그때는 화면에
 * 남아 있는 결과가 없어("오류는 결과를 지우지 않는다" 규칙이 지킬 대상이 없다) 카드가
 * 통째로 사라졌다. 70대 평균 결과가 8.5건이라, 목록을 하나씩 눌러 보는 사람이 정확히 걸린다.
 *
 * **무엇을 저장하는가.** 커서 없는 응답 하나(= 그 조합의 **모든 탭 1페이지**)와 AI 안내,
 * 그리고 스크롤 위치다. 2페이지 이후는 저장하지 않는다 — 흔한 경로가 아니고, 커서와 함께
 * 관리하면 얻는 것보다 어긋날 여지가 커진다.
 *
 * **어디에 저장하는가.** `sessionStorage` 다. 자유입력을 두는 곳과 같다(§8) — 탭을 닫으면
 * 사라지고, 다른 탭·다른 사이트에서 읽을 수 없으며, 서버로 나가지 않는다. 담기는 것은
 * 공개된 공고 메타데이터와 화면에 이미 떠 있던 요약 문구뿐이다.
 *
 * **언제 버리는가.** (1) 인적사항을 다시 저장하면 온보딩이 지운다 — 조건이 달라졌는데 옛
 * 결과를 되살리면 안 된다. (2) TTL 이 지나면 무시한다. (3) 자유입력·전체보기·정렬 축이
 * 하나라도 다르면 쓰지 않는다. 어느 쪽이든 평소대로 `/api/match` 를 부른다.
 */
import type { AiAnswerStatus, MatchResponse, ResultSort } from "./types";
import { RESULTS_SCROLL_KEY, RESULTS_SNAPSHOT_KEY } from "./client-keys";

/**
 * 스냅샷 유효 시간. 공고는 새벽 배치로 하루 한 번 갱신되므로 분 단위 신선도가 필요하지는
 * 않지만, 상세를 오래 읽다 돌아오는 것까지는 살려야 한다. 지나면 조용히 다시 검색한다.
 */
export const SNAPSHOT_TTL_MS = 30 * 60_000;

/**
 * 직렬화 상한. 실 DB 에서는 탭 6개 × 1페이지 15건에 공고 본문까지 붙어 수백 KB가 될 수 있다.
 * sessionStorage 한도(브라우저별 약 5MB)를 혼자 채우지 않도록 넘치면 저장을 포기한다 —
 * 저장하지 못해도 동작은 지금과 같다(뒤로가기에서 다시 검색). 캐시는 최적화지 정답이 아니다.
 */
export const MAX_SNAPSHOT_BYTES = 1_500_000;

export type SnapshotPayload = MatchResponse & { ok: true };

export interface ResultsSnapshot {
  v: 1;
  savedAt: number;
  /** 자유입력. 달라지면 다른 검색이다 */
  q: string | null;
  /** 커서 없는 응답 하나가 이 조합의 모든 탭 1페이지다 */
  ignoreIntent: boolean;
  sort: ResultSort;
  payload: SnapshotPayload;
  aiAnswer: string | null;
  aiAnswerStatus: AiAnswerStatus;
}

/** 스크롤 위치는 따로 둔다 — 스크롤할 때마다 큰 응답을 다시 직렬화하지 않으려고 */
export interface ResultsScroll {
  /** 어느 화면의 위치인가 (`resultsHref()` 결과) */
  href: string;
  y: number;
}

type MaybeStorage = Storage | null;

function storage(): MaybeStorage {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // 쿠키·저장소를 막아 둔 브라우저. 저장이 안 될 뿐 화면은 그대로 동작한다.
    return null;
  }
}

/** 이 스냅샷을 지금 화면에 되살려도 되는가. 저장소와 무관한 순수 판정이라 그대로 테스트한다. */
export function isUsableSnapshot(
  snap: ResultsSnapshot | null,
  want: { q: string | null; ignoreIntent: boolean; sort: ResultSort; page: number },
  now: number,
): snap is ResultsSnapshot {
  if (!snap || snap.v !== 1) return false;
  if (now - snap.savedAt > SNAPSHOT_TTL_MS) return false;
  // 2페이지 이후는 저장하지 않는다 — 스냅샷은 언제나 1페이지다.
  if (want.page !== 1) return false;
  return (
    snap.q === want.q &&
    snap.ignoreIntent === want.ignoreIntent &&
    snap.sort === want.sort &&
    Boolean(snap.payload?.pages)
  );
}

export function readSnapshot(store: MaybeStorage = storage()): ResultsSnapshot | null {
  try {
    const raw = store?.getItem(RESULTS_SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as ResultsSnapshot) : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(
  snap: ResultsSnapshot,
  store: MaybeStorage = storage(),
): boolean {
  if (!store) return false;
  try {
    const raw = JSON.stringify(snap);
    if (raw.length > MAX_SNAPSHOT_BYTES) return false;
    store.setItem(RESULTS_SNAPSHOT_KEY, raw);
    return true;
  } catch {
    // 용량 초과(QuotaExceededError) 등. 저장을 포기하고 평소대로 다시 검색한다.
    return false;
  }
}

/** AI 안내는 카드보다 늦게 도착한다 — 이미 저장한 스냅샷에 얹는다 */
export function updateSnapshotAnswer(
  aiAnswer: string | null,
  aiAnswerStatus: AiAnswerStatus,
  store: MaybeStorage = storage(),
): void {
  const snap = readSnapshot(store);
  if (!snap) return;
  writeSnapshot({ ...snap, aiAnswer, aiAnswerStatus }, store);
}

/** 인적사항이 바뀌면 옛 결과를 되살리면 안 된다 — 온보딩이 저장 직후 부른다 */
export function clearSnapshot(store: MaybeStorage = storage()): void {
  try {
    store?.removeItem(RESULTS_SNAPSHOT_KEY);
    store?.removeItem(RESULTS_SCROLL_KEY);
  } catch {
    /* 저장소를 못 쓰면 애초에 남은 것도 없다 */
  }
}

export function readScroll(store: MaybeStorage = storage()): ResultsScroll | null {
  try {
    const raw = store?.getItem(RESULTS_SCROLL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResultsScroll;
    return typeof parsed?.href === "string" && Number.isFinite(parsed?.y) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeScroll(scroll: ResultsScroll, store: MaybeStorage = storage()): void {
  try {
    store?.setItem(RESULTS_SCROLL_KEY, JSON.stringify(scroll));
  } catch {
    /* 위치 하나 못 남기는 것으로 화면이 멈추지는 않는다 */
  }
}
