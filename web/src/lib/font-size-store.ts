/**
 * 글자 크기 설정 저장소 (SPEC §8 접근성).
 *
 * React state 로 들고 있다가 effect 에서 localStorage 를 읽어 덮어쓰면
 * 첫 페인트가 기본 크기로 한 번 그려졌다가 커지는 깜빡임이 생긴다.
 * 고령층 대상 기능에서 이건 실제로 거슬리는 결함이므로,
 *  1) layout 의 인라인 스크립트가 페인트 전에 <html data-fontsize> 를 세팅하고
 *  2) 컴포넌트는 useSyncExternalStore 로 그 값을 읽기만 한다.
 */
export type FontSize = "normal" | "large" | "xlarge";

export const FONT_SIZE_KEY = "amuguna.fontsize";
const VALID: FontSize[] = ["normal", "large", "xlarge"];

/** layout 의 <head> 에 인라인으로 넣는 스크립트. 페인트 전에 실행돼 깜빡임을 없앤다. */
export const FONT_SIZE_BOOTSTRAP = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
  FONT_SIZE_KEY,
)});if(v==="large"||v==="xlarge"){document.documentElement.dataset.fontsize=v}else{document.documentElement.dataset.fontsize="normal"}}catch(e){document.documentElement.dataset.fontsize="normal"}})();`;

const listeners = new Set<() => void>();

export function subscribeFontSize(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export function getFontSize(): FontSize {
  const v = document.documentElement.dataset.fontsize as FontSize | undefined;
  return v && VALID.includes(v) ? v : "normal";
}

/** 서버 렌더 시의 값 — 스크립트가 아직 돌기 전이므로 기본값 */
export function getServerFontSize(): FontSize {
  return "normal";
}

export function setFontSize(v: FontSize): void {
  document.documentElement.dataset.fontsize = v;
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, v);
  } catch {
    // 사생활 보호 모드 등에서 localStorage 가 막혀 있어도 이번 세션에는 적용된다
  }
  for (const l of listeners) l();
}
