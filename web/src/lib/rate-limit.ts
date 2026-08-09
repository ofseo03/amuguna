/**
 * Rate limit (SPEC §8 보안) — 익명 세션 10회/분 **AND** IP 60회/분.
 *
 * 검색 1회 = 임베딩 API 과금 1회이므로 abuse 가 곧 비용이고,
 * 인증이 없는 서비스라 이것이 유일한 방어선이다.
 *
 * 두 버킷을 **독립적으로** 센다. 세션과 IP 를 한 문자열로 합치면 쿠키만 버려도
 * 새 버킷이 생겨 한도가 사실상 무한이 된다 (/api/profile 이 세션을 새로 발급하므로
 * 공격자는 매번 새 세션을 얻을 수 있다). IP 버킷은 세션 회전으로 우회되지 않는다.
 *
 * IP 한도를 세션 한도보다 크게 둔 이유: 회사·학교·모바일 캐리어 NAT 뒤에서
 * 여러 사용자가 한 IP 를 공유한다. 세션 한도(10)의 6배까지 허용해 정상 공유는
 * 통과시키되, 무한 회전은 막는다.
 *
 * 인메모리 고정 윈도우. 단일 인스턴스 전제이며, Vercel 다중 인스턴스에서는
 * 인스턴스당 한도가 되어 실효 한도가 느슨해진다 — MVP 범위에서 감수하고,
 * 트래픽이 늘면 Upstash Redis 등 공유 저장소로 교체한다 (교체 지점은 이 파일 하나).
 */

const WINDOW_MS = 60_000;
const LIMIT = 10;
/** IP 단위 상한 — NAT 공유를 감안해 세션 한도보다 넉넉히 둔다 */
const IP_LIMIT = 60;
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

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 초 단위 — Retry-After 헤더용 */
  retryAfter: number;
  limit: number;
}

export function checkRateLimit(key: string, now = Date.now(), limit = LIMIT): RateLimitResult {
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
      retryAfter: Math.ceil((b.resetAt - now) / 1000),
      limit,
    };
  }
  b.count += 1;
  return {
    allowed: true,
    remaining: limit - b.count,
    retryAfter: 0,
    limit,
  };
}

/**
 * 프록시 뒤(Vercel)에서의 클라이언트 IP.
 *
 * `x-forwarded-for` 는 클라이언트가 임의로 붙일 수 있는 헤더다. 신뢰할 수 있는 건
 * **우리 프록시가 마지막에 덧붙인 값**, 즉 오른쪽 끝이다. 왼쪽 끝(맨 앞)을 쓰면
 * 요청마다 다른 값을 넣어 IP 버킷을 무한히 만들 수 있다.
 * 프록시 홉이 여러 개면 TRUSTED_PROXY_HOPS 로 오른쪽에서 몇 번째인지 지정한다.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
      const index = parts.length - Math.max(1, Number.isFinite(hops) ? hops : 1);
      return parts[Math.max(0, index)];
    }
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * 세션 버킷과 IP 버킷을 각각 검사한다. 하나라도 걸리면 거부.
 *
 * `scope` 는 엔드포인트별 네임스페이스 (예: "subscribe"). 검색과 알림 신청이
 * 같은 버킷을 나눠 쓰지 않게 한다.
 */
export function checkRequestLimits(
  sessionId: string | null,
  req: Request,
  scope = "",
  now = Date.now(),
): RateLimitResult {
  const prefix = scope ? `${scope}:` : "";
  const ip = checkRateLimit(`${prefix}ip:${clientIp(req)}`, now, IP_LIMIT);
  if (!ip.allowed) return ip;
  // 세션 없는 요청도 한 버킷으로 묶어 센다 — 쿠키를 아예 안 보내는 경로 방어.
  return checkRateLimit(`${prefix}sid:${sessionId ?? "anon"}`, now, LIMIT);
}
