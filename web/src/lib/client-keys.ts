/**
 * 클라이언트 저장소 키.
 *
 * 자유입력은 서버에 저장하지 않는다 (SPEC §8). 결과 화면 새로고침·탭 전환 시
 * 같은 결과를 다시 그리기 위해 브라우저 탭 메모리에만 잠시 둔다 —
 * sessionStorage 라 탭을 닫으면 사라지고, 다른 탭·다른 사이트에서 읽을 수 없다.
 */
export const QUERY_STORAGE_KEY = "amuguna.query";

/**
 * 결과 안에서 찾기의 낱말.
 *
 * 탭·페이지·전체보기는 URL 로 되살리지만(`results-location.ts`) 이 낱말은 URL 에 넣지 않는다 —
 * 사용자가 직접 친 자유입력이라 주소창·리퍼러·공유 링크에 남기지 않는다는 규칙이 그대로 적용된다.
 * 그래도 상세를 봤다 돌아오면 정렬은 유지되어야 하므로 같은 탭 메모리에 둔다.
 */
export const SORT_QUERY_STORAGE_KEY = "amuguna.sortQuery";
