/**
 * 화면 크기(확대) 설정 저장소 (SPEC §8 접근성).
 *
 * 루트 font-size 를 배율로 바꾼다. 타이포·여백·행간이 전부 rem 이라
 * 이 값 하나만 움직이면 화면 전체가 같은 비율로 커지고 줄어든다.
 *
 * React state 로 들고 있다가 effect 에서 localStorage 를 읽어 덮어쓰면
 * 첫 페인트가 기본 크기로 한 번 그려졌다가 커지는 깜빡임이 생긴다.
 * 고령층 대상 기능에서 이건 실제로 거슬리는 결함이므로,
 *  1) layout 의 인라인 스크립트가 페인트 전에 <html> 의 배율을 세팅하고
 *  2) 컴포넌트는 useSyncExternalStore 로 그 값을 읽기만 한다.
 *
 * 파일명은 예전 이름을 유지한다 — 저장 키와 함께 security.test.mjs 가 이 경로를 검사한다.
 */

/** 배율은 퍼센트 정수로 다룬다 (100 = 기본 16px). 슬라이더 값과 화면 표시가 같은 단위다. */
export const MIN_ZOOM = 100;
export const MAX_ZOOM = 160;
export const ZOOM_STEP = 10;
export const DEFAULT_ZOOM = 100;

/** 저장 키는 그대로 둔다 — 예전 "large"/"xlarge" 값이 그대로 배율로 넘어온다. */
export const FONT_SIZE_KEY = "amuguna.fontsize";

/**
 * layout 의 <head> 에 인라인으로 넣는 스크립트. 페인트 전에 실행돼 깜빡임을 없앤다.
 *
 * 보간은 전부 `JSON.stringify(코드 안 상수)` 다 — 외부 값이 스크립트 문맥으로 흘러들 수 없다.
 * (security.test.mjs 가 이 형태를 강제한다.)
 */
export const FONT_SIZE_BOOTSTRAP = `(function(){try{var d=document.documentElement;var v=localStorage.getItem(${JSON.stringify(
  FONT_SIZE_KEY,
)});var z=v==="large"?120:v==="xlarge"?130:parseInt(v,10);if(!(z>=${JSON.stringify(
  MIN_ZOOM,
)}&&z<=${JSON.stringify(MAX_ZOOM)}))z=${JSON.stringify(
  DEFAULT_ZOOM,
)};d.dataset.zoom=String(z);d.style.setProperty("--screen-zoom",String(z/100))}catch(e){}})();`;

const listeners = new Set<() => void>();

/** 슬라이더 눈금에 맞추고 범위 밖 값을 잘라낸다. 저장된 값도 이 함수를 통과한다. */
export function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_ZOOM;
  const snapped =
    MIN_ZOOM + Math.round((v - MIN_ZOOM) / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, snapped));
}

export function subscribeZoom(cb: () => void): () => void {
  listeners.add(cb);
  // 다른 탭에서 바꾼 값도 따라온다
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

export function getZoom(): number {
  return clampZoom(Number(document.documentElement.dataset.zoom));
}

/** 서버 렌더 시의 값 — 부트스트랩 스크립트가 아직 돌기 전이므로 기본값 */
export function getServerZoom(): number {
  return DEFAULT_ZOOM;
}

export function setZoom(v: number): void {
  const z = clampZoom(v);
  const d = document.documentElement;
  d.dataset.zoom = String(z);
  d.style.setProperty("--screen-zoom", String(z / 100));
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, String(z));
  } catch {
    // 사생활 보호 모드 등에서 localStorage 가 막혀 있어도 이번 세션에는 적용된다
  }
  for (const l of listeners) l();
}
