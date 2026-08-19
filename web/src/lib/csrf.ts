/**
 * CSRF 방어 (SPEC §8 보안).
 *
 * 이 서비스에는 로그인이 없지만 CSRF 가 무의미하지는 않다. 프로필 쿠키는 httpOnly 라
 * 공격자가 읽을 수 없어도, 크로스사이트에서 `POST /api/profile` 을 날려 **피해자의
 * 프로필을 몰래 바꿔치기**할 수는 있다. 그러면 이후 사용자가 보는 결과가 통째로 달라진다.
 * `POST /api/match` 는 임베딩 API 과금을 유발하므로 비용 측면의 abuse 경로이기도 하다.
 *
 * 방어는 두 겹이다.
 *
 * 1. **SameSite=Lax** (session.ts) — 크로스사이트 POST 에는 쿠키가 아예 실리지 않는다.
 *    최신 브라우저에서는 이것만으로 대부분 차단된다.
 * 2. **Origin 검증** (이 파일) — SameSite 를 지원하지 않는 구형 브라우저와,
 *    같은 사이트로 취급되는 서브도메인에서 오는 요청까지 막는다.
 *
 * 토큰(double-submit) 대신 Origin 검증을 쓰는 이유: 토큰은 클라이언트 fetch 를 전부
 * 고쳐야 하고 쿠키를 하나 더 늘린다. OWASP 도 Origin/Referer 검증을 유효한 단독 방어로
 * 인정하며, 이 서비스의 요청 경로가 두 개뿐이라 검증 지점이 명확하다.
 */

/** 브라우저가 크로스사이트 요청임을 스스로 알려주는 헤더. 있으면 이것이 가장 정확하다. */
const SAFE_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

export interface CsrfResult {
  ok: boolean;
  /** 거부 사유 — 로그용. 사용자에게는 노출하지 않는다 */
  reason?: string;
}

/**
 * 요청이 우리 출처에서 왔는가.
 *
 * `Origin` 이 없는 요청(구형 브라우저, 일부 프록시, curl)은 통과시킨다 — 헤더가 없다는
 * 이유로 막으면 정상 사용자를 차단하게 되고, 그 경우는 SameSite 가 이미 막고 있다.
 * 확실히 다른 출처라고 **말한** 요청만 거부한다.
 */
export function checkCsrf(req: Request): CsrfResult {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && !SAFE_FETCH_SITES.has(fetchSite)) {
    // 'cross-site' — 브라우저가 직접 크로스사이트라고 알려준 경우
    return { ok: false, reason: `sec-fetch-site=${fetchSite}` };
  }

  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return { ok: true };

  const expectedHost = requestHost(req);
  if (!expectedHost) return { ok: true };

  // **스킴이 아니라 호스트로 비교한다.**
  // 프록시가 `X-Forwarded-Proto` 를 주지 않는 환경(로컬 http, LAN IP 접속)에서 스킴을
  // 추측하면 정상 요청을 403 으로 막는다. 실제로 http://127.0.0.1:3000 과 사내망 IP
  // 접속이 전부 차단됐다. 스킴 다운그레이드는 HSTS 와 `upgrade-insecure-requests`
  // (next.config.ts CSP) 가 막는 문제이고, CSRF 가 가려야 하는 것은 **어느 사이트가
  // 요청을 보냈는가**이므로 호스트 비교로 충분하다.
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, reason: `origin=${origin} (형식 오류)` };
  }
  if (originHost !== expectedHost) {
    return { ok: false, reason: `origin=${originHost} expected=${expectedHost}` };
  }
  return { ok: true };
}

/**
 * 이 요청이 도달한 호스트.
 *
 * Vercel 등 프록시 뒤에서는 `req.url` 의 호스트가 내부 주소일 수 있으므로
 * `X-Forwarded-Host` 를 우선한다. 이 헤더는 플랫폼이 설정하는 값이라
 * 클라이언트가 임의로 덮어쓸 수 없다.
 */
function requestHost(req: Request): string | null {
  return req.headers.get("x-forwarded-host") ?? req.headers.get("host");
}

/** 거부 시 사용자에게 보이는 문구 — 공격 여부를 단정하지 않고 재시도를 안내한다 */
export const CSRF_MESSAGE = "요청을 처리할 수 없습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.";
