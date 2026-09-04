/**
 * Rate limit (SPEC §8 보안) — 세션 우선, IP 는 훨씬 느슨한 이중 상한.
 *
 * 검색 1회 = 임베딩 API 과금 1회이므로 abuse 가 곧 비용이고,
 * 인증이 없는 서비스라 이것이 유일한 방어선이다.
 *
 * **왜 두 한도를 따로 두는가.** 대학·회사·모바일 캐리어는 NAT 뒤에 있어 수십~수백 명이
 * 하나의 공인 IP 로 나온다. 세션과 IP 에 같은 한도를 걸면 같은 망의 정상 사용자가
 * 서로의 한도를 잡아먹어 차단된다 — 심사위원 여러 명이 같은 망에서 접속하는
 * 상황(9/7~9/11)이 정확히 이 케이스다. 따라서
 *   - **세션**: 개인 단위 실질 한도. 낮게 잡는다 (기본 10회/분)
 *   - **IP**: 세션 쿠키를 갈아끼우는 abuse 만 막는 안전망. 높게 잡는다 (기본 600회/분)
 * 세션만 세면 쿠키 회전으로 우회되고, IP 만 세면 NAT 가 막힌다. 둘 다 센다.
 *
 * **심사 구간 완화 스위치.** 두 한도 모두 환경변수로 덮어쓸 수 있고 매 호출마다 읽는다 —
 * 코드 변경·재배포 없이 환경변수 값만 바꿔 적용한다. `0` 은 해당 축의 제한 해제다.
 *   RATE_LIMIT_SESSION_PER_MIN=0   # 세션 한도 해제
 *   RATE_LIMIT_ANON_PER_MIN=0      # 세션 쿠키 없는 요청의 한도 해제
 *   RATE_LIMIT_IP_PER_MIN=0        # IP 한도 해제 (= rate limit 전면 해제)
 *
 * 인메모리 고정 윈도우. 단일 인스턴스 전제이며, Vercel 다중 인스턴스에서는
 * 인스턴스당 한도가 되어 실효 한도가 느슨해진다 — MVP 범위에서 감수하고,
 * 트래픽이 늘면 Upstash Redis 등 공유 저장소로 교체한다 (교체 지점은 이 파일 하나).
 */

const WINDOW_MS = 60_000;

/** 개인 단위 실질 한도 */
export const DEFAULT_SESSION_LIMIT = 10;
/**
 * 세션 쿠키가 없는 요청의 IP 단위 한도.
 *
 * 세션 축을 통째로 건너뛰면 쿠키를 지운 클라이언트가 IP 한도(600/분)를 그대로 쓰게 되어
 * 과금 abuse 상한이 60배로 뛴다. 그렇다고 개인 한도(10/분)를 IP 로 물리면 그것이 곧
 * NAT 차단이다. 정상 사용자는 프로필 발급 시 세션 쿠키가 함께 생기므로 이 경로로 오는
 * 요청은 드물다 — 개인 한도보다는 넉넉하고 IP 한도보다는 훨씬 빡빡한 값을 둔다.
 */
export const DEFAULT_ANON_LIMIT = 60;
/**
 * NAT 안전망. 한 공인 IP 뒤에 60명이 분당 10회씩 쓰는 상황까지 통과시킨다 —
 * 세션 한도가 이미 개인을 제어하므로 이 값은 "쿠키를 회전시키는 자동화"만 걸리면 된다.
 */
export const DEFAULT_IP_LIMIT = 600;

/** 메모리 누수 방지 상한 — 초과 시 만료 항목부터 정리한다 */
const MAX_KEYS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function sweep(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

/**
 * 환경변수 한도 파싱. 매 호출마다 읽으므로 재배포 없이 값 변경이 반영된다.
 * 음수·비수치는 기본값으로 되돌린다 — 오타 하나가 서비스를 막지 않게 한다.
 */
export function envLimit(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`[rate-limit] ${name}=${raw} 값이 올바르지 않아 기본값 ${fallback} 을 씁니다.`);
    return fallback;
  }
  return parsed;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 초 단위 — Retry-After 헤더용 */
  retryAfter: number;
  limit: number;
  /** 어느 축에서 걸렸는지. 로그·디버깅용 (사용자에게는 노출하지 않는다) */
  scope?: "session" | "ip";
}

/**
 * 단일 버킷 검사. `limit === 0` 은 제한 해제이며 버킷을 만들지도 않는다.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  now = Date.now(),
): RateLimitResult {
  if (limit <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfter: 0, limit: 0 };
  }
  if (buckets.size > MAX_KEYS) sweep(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfter: 0, limit };
  }
  if (b.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      limit,
    };
  }
  b.count += 1;
  return { allowed: true, remaining: limit - b.count, retryAfter: 0, limit };
}

/** 프록시 뒤(Vercel)에서의 클라이언트 IP */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * 세션 우선 + IP 안전망.
 *
 * `bucket` 은 개인 축의 이름공간이다 — `/api/match`, `/api/answer`, `/api/profile` 이 각자
 * 한도(기본 10회/분)를 갖는다. IP 축은 라우트와 무관하게 하나다.
 *
 * 세션 쿠키가 없으면 개인 한도 대신 IP 단위 익명 한도(기본 60회/분)를 쓴다.
 * 개인 한도(10회/분)를 IP 로 대신 물리면 그것이 곧 NAT 차단이고, 반대로 축을 아예
 * 건너뛰면 쿠키를 지우는 것만으로 IP 한도(600회/분)를 다 쓰게 된다.
 * `/api/match` 는 프로필 쿠키를 요구하고 프로필 발급 시 세션 쿠키가 함께 생기므로
 * 세션 없는 경로는 실제로는 드물다.
 */
export function checkSessionAndIpRateLimit(
  sessionId: string | null,
  req: Request,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  bucket = "match",
): RateLimitResult {
  const sessionLimit = envLimit("RATE_LIMIT_SESSION_PER_MIN", DEFAULT_SESSION_LIMIT, env);
  const ipLimit = envLimit("RATE_LIMIT_IP_PER_MIN", DEFAULT_IP_LIMIT, env);

  const anonLimit = envLimit("RATE_LIMIT_ANON_PER_MIN", DEFAULT_ANON_LIMIT, env);

  const ip = clientIp(req);
  const ipResult = checkRateLimit(`ip:${ip}`, ipLimit, now);
  // IP 축이 이미 막았으면 두 번째 축의 카운트를 태우지 않는다.
  // 세션이 있으면 개인 한도로, 없으면 IP 단위 익명 한도로 센다 — 어느 쪽이든
  // 두 번째 축이 반드시 존재해야 세션 쿠키를 지우는 것만으로 상한이 뛰지 않는다.
  // 개인 축은 라우트(bucket)별로 따로 센다 — 검색·페이지 넘김으로 한도를 다 쓴 사람이
  // 프로필 수정까지 막히면 안 된다. IP 안전망은 쿠키 회전 abuse 만 보므로 공유한다.
  const sessionResult = !ipResult.allowed
    ? null
    : sessionId
      ? checkRateLimit(`session:${bucket}:${sessionId}`, sessionLimit, now)
      : checkRateLimit(`anon:${bucket}:${ip}`, anonLimit, now);

  if (!ipResult.allowed) return { ...ipResult, scope: "ip" };
  if (sessionResult && !sessionResult.allowed) return { ...sessionResult, scope: "session" };

  // 통과 시에는 사용자에게 의미 있는 쪽(더 빡빡한 세션 축)을 보고한다.
  const reported = sessionResult ?? ipResult;
  return {
    allowed: true,
    remaining: reported.remaining,
    retryAfter: 0,
    limit: reported.limit,
  };
}

/**
 * 차단 시 사용자에게 보이는 문구 — 원인(과다 요청)이 아니라 행동(재시도)을 알린다.
 *
 * "요청이 많아"라고 쓰지 않는다. 이 한도는 사실상 개인 단위라 걸리는 사람은 본인이 눌러서
 * 걸린 것인데, 서버 혼잡으로 읽히면 무엇을 했길래 막혔는지 짐작할 수가 없다.
 */
export function rateLimitMessage(retryAfter: number, action = "검색"): string {
  const seconds = Math.max(1, retryAfter);
  return `잠시 뒤에 다시 ${action}할 수 있습니다. ${seconds}초 후에 다시 시도해 주세요.`;
}
