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
