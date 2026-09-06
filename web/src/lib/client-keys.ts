/**
 * 클라이언트 저장소 키.
 *
 * 자유입력은 서버에 저장하지 않는다 (SPEC §8). 결과 화면 새로고침·탭 전환 시
 * 같은 결과를 다시 그리기 위해 브라우저 탭 메모리에만 잠시 둔다 —
 * sessionStorage 라 탭을 닫으면 사라지고, 다른 탭·다른 사이트에서 읽을 수 없다.
 *
 * 결과 화면의 탭·페이지·전체보기·정렬 축은 자유입력이 아니므로 여기가 아니라 URL 이
 * 기억한다 (`results-location.ts`).
 */
export const QUERY_STORAGE_KEY = "amuguna.query";

/**
 * 결과 화면 스냅샷 — 상세를 봤다 뒤로 왔을 때 재검색 없이 그대로 되살리기 위한 것
 * (`results-snapshot.ts`). 공개된 공고 메타데이터와 화면에 이미 떠 있던 요약뿐이고,
 * 자유입력과 같은 저장소(sessionStorage)라 탭을 닫으면 함께 사라진다.
 */
export const RESULTS_SNAPSHOT_KEY = "amuguna.results";
/** 결과 화면에서 보고 있던 스크롤 위치. 스냅샷과 따로 두어 자주 써도 부담이 없다. */
export const RESULTS_SCROLL_KEY = "amuguna.results.scroll";
