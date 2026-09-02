/**
 * 글자 크기 설정 저장소 (SPEC §8 접근성).
 *
 * 값은 루트 font-size 를 px 로 적은 수 하나다. 슬라이더가 연속으로 움직이므로
 * 단계 이름("large" 따위) 대신 숫자를 그대로 들고 있는 편이 짧다.
 *
 * React state 로 들고 있다가 effect 에서 localStorage 를 읽어 덮어쓰면
 * 첫 페인트가 기본 크기로 한 번 그려졌다가 커지는 깜빡임이 생긴다.
 * 고령층 대상 기능에서 이건 실제로 거슬리는 결함이므로,
 *  1) layout 의 인라인 스크립트가 페인트 전에 <html style="font-size"> 를 세팅하고
 *  2) 컴포넌트는 useSyncExternalStore 로 그 값을 읽기만 한다.
 */
export const FONT_SIZE_KEY = "amuguna.fontsize";
export const FONT_SIZE_MIN = 16;
export const FONT_SIZE_MAX = 22;
/** 0.5px 씩. 끝에서 끝까지 12칸이라 드래그는 연속처럼 보이고 화살표키는 또박또박 움직인다. */
export const FONT_SIZE_STEP = 0.5;

/** layout 의 <head> 에 인라인으로 넣는 스크립트. 페인트 전에 실행돼 깜빡임을 없앤다. */
export const FONT_SIZE_BOOTSTRAP = `(function(){try{var v=parseFloat(localStorage.getItem(${JSON.stringify(
  FONT_SIZE_KEY,
)}));if(v>=${JSON.stringify(FONT_SIZE_MIN)}&&v<=${JSON.stringify(
  FONT_SIZE_MAX,
)}){document.documentElement.style.fontSize=v+"px"}}catch(e){}})();`;

const listeners = new Set<() => void>();

export function subscribeFontSize(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export function getFontSize(): number {
  const v = parseFloat(document.documentElement.style.fontSize);
  return v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX ? v : FONT_SIZE_MIN;
}

/** 서버 렌더 시의 값 — 스크립트가 아직 돌기 전이므로 기본값 */
export function getServerFontSize(): number {
  return FONT_SIZE_MIN;
}

export function setFontSize(v: number): void {
  const px = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, v));
  document.documentElement.style.fontSize = `${px}px`;
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(px));
  } catch {
    // 사생활 보호 모드 등에서 localStorage 가 막혀 있어도 이번 세션에는 적용된다
  }
  for (const l of listeners) l();
}
