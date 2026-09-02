/**
 * 클라이언트 저장소 키.
 *
 * 자유입력은 서버에 저장하지 않는다 (SPEC §8). 결과 화면 새로고침·탭 전환 시
 * 같은 결과를 다시 그리기 위해 브라우저 탭 메모리에만 잠시 둔다 —
 * sessionStorage 라 탭을 닫으면 사라지고, 다른 탭·다른 사이트에서 읽을 수 없다.
 */
export const QUERY_STORAGE_KEY = "amuguna.query";
export const RESULT_STORAGE_KEY = "amuguna.result.v2";
export const AI_ANSWER_STORAGE_KEY = "amuguna.ai-answer.v2";
