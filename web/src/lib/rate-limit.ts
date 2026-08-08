/**
 * Rate limit (SPEC §8 보안) — 익명 세션 + IP 기준 10회/분.
 *
 * 검색 1회 = 임베딩 API 과금 1회이므로 abuse 가 곧 비용이고,
 * 인증이 없는 서비스라 이것이 유일한 방어선이다.
 *
 * 인메모리 고정 윈도우. 단일 인스턴스 전제이며, Vercel 다중 인스턴스에서는
 * 인스턴스당 한도가 되어 실효 한도가 느슨해진다 — MVP 범위에서 감수하고,
 * 트래픽이 늘면 Upstash Redis 등 공유 저장소로 교체한다 (교체 지점은 이 파일 하나).
 */

const WINDOW_MS = 60_000;
const LIMIT = 10;
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

export function checkRateLimit(key: string, now = Date.now()): RateLimitResult {
  if (buckets.size > MAX_KEYS) sweep(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: LIMIT - 1, retryAfter: 0, limit: LIMIT };
  }
  if (b.count >= LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((b.resetAt - now) / 1000),
      limit: LIMIT,
    };
  }
  b.count += 1;
  return {
    allowed: true,
    remaining: LIMIT - b.count,
    retryAfter: 0,
    limit: LIMIT,
  };
}

/** 프록시 뒤(Vercel)에서의 클라이언트 IP */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function rateLimitKey(sessionId: string | null, req: Request): string {
  return `${sessionId ?? "anon"}|${clientIp(req)}`;
}
