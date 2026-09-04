/**
 * POST /api/match — 탭별 카드 리스트(스코어순) + 근접탈락 + 완화 단계 + 페이지 커서 (SPEC §9).
 *
 * 커서 없는 요청에는 **모든 탭의 1페이지**를 함께 담아 보낸다. 탭 전환은 이미 받아둔 결과를
 * 좁히는 것뿐인데 그때마다 이 라우트를 부르면 평범한 조작 몇 번으로 rate limit 에 걸린다.
 *
 * 자유입력은 이 요청 시점에만 사용하고 저장하지 않는다 (§8).
 * 질의가 있는 최초 전체 검색은 매칭 결과 상위 5건으로 실시간 AI 안내를 1회 생성한다.
 * Rate limit: 익명 세션 + IP 기준 10회/분 (§8).
 */
import { NextResponse } from "next/server";
import { runMatch } from "@/lib/matching";
import { generateLiveAnswer } from "@/lib/live-answer";
import { readProfile, readSessionId, upgradeProfileCookie } from "@/lib/session";
import { CSRF_MESSAGE, checkCsrf } from "@/lib/csrf";
import { checkSessionAndIpRateLimit, rateLimitMessage } from "@/lib/rate-limit";
import { validateCursor, validateForm, validateQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 함수 실행 상한(초). 요청 예산 = 질의 임베딩 15초 + SQL 수 회 + OpenRouter 12초 (SPEC §8 성능).
 * 명시하지 않으면 플랫폼 기본값(10~15초)이 이 예산보다 먼저 끊어, 임베딩·LLM 의 degraded
 * 경로가 실행될 기회 없이 504 가 난다. 예산 합계에 여유를 조금 더한 값이다.
 */
export const maxDuration = 40;

export async function POST(req: Request) {
  // CSRF (§8): 검색은 임베딩·OpenRouter 비용을 만들 수 있으므로 크로스사이트 호출을 막는다
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

  const form = validateForm(body.form);
  const started = Date.now();
  try {
    const result = await runMatch({
      profile,
      query: q.value,
      form,
      cursor: cursor.value,
      ignoreIntent: body.ignoreIntent === true,
    });
    const ai = await generateLiveAnswer({
      query: q.value,
      cursor: cursor.value,
      cards: result.pages.all?.cards ?? [],
    });
    return NextResponse.json(
      {
        ok: true,
        ...result,
        aiAnswer: ai.text,
        aiAnswerStatus: ai.status,
        tookMs: Date.now() - started,
      },
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
