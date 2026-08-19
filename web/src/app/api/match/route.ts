/**
 * POST /api/match — 카드 리스트(스코어순) + 근접탈락 + 완화 단계 + 페이지 커서 (SPEC §9).
 *
 * 자유입력은 이 요청 시점에만 사용하고 저장하지 않는다 (§8).
 * 요청 경로에 LLM 은 없다 (§7.5) — 임베딩 1회 + 조회 1회가 전부다.
 * Rate limit: 익명 세션 + IP 기준 10회/분 (§8).
 */
import { NextResponse } from "next/server";
import { runMatch } from "@/lib/matching";
import { readProfile, readSessionId, upgradeProfileCookie } from "@/lib/session";
import { CSRF_MESSAGE, checkCsrf } from "@/lib/csrf";
import { checkSessionAndIpRateLimit, rateLimitMessage } from "@/lib/rate-limit";
import { validateCursor, validateForm, validateQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // CSRF (§8): 검색 1회 = 임베딩 API 과금 1회이므로 크로스사이트 호출은 곧 비용이다
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    console.warn(`[api/match] CSRF 거부 (${csrf.reason})`);
    return NextResponse.json({ ok: false, code: "csrf", message: CSRF_MESSAGE }, { status: 403 });
  }

  const sessionId = await readSessionId();

  const rl = checkSessionAndIpRateLimit(sessionId, req);
  if (!rl.allowed) {
    // 어느 축에서 걸렸는지는 로그로만 남긴다 — NAT 뒤 대량 접속을 사후에 식별하기 위한 것이고,
    // 사용자에게는 재시도 안내만 보인다.
    console.warn(`[api/match] rate limited (scope=${rl.scope}, limit=${rl.limit})`);
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        message: rateLimitMessage(rl.retryAfter),
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // 구형 서명 쿠키를 암호화 형식으로 조용히 교체한다 (라우트 핸들러에서만 가능)
  await upgradeProfileCookie();

  const profile = await readProfile();
  if (!profile) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_profile",
        message: "먼저 기본 정보를 입력해 주세요.",
      },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // 본문 없이 호출하면 자유입력을 건너뛴 것으로 본다
  }

  const q = validateQuery(body.query);
  if (!q.ok) {
    return NextResponse.json({ ok: false, errors: q.errors }, { status: 400 });
  }
  const cursor = validateCursor(body.cursor);
  if (!cursor.ok) {
    return NextResponse.json({ ok: false, errors: cursor.errors }, { status: 400 });
  }

  try {
    const result = await runMatch({
      profile,
      query: q.value,
      form: validateForm(body.form),
      cursor: cursor.value,
    });
    return NextResponse.json(
      { ok: true, ...result },
      {
        headers: {
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": String(rl.remaining),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    console.error("[api/match] 매칭 실패", e);
    return NextResponse.json(
      { ok: false, code: "match_failed", message: "결과를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
