/**
 * POST /api/answer — 질의가 있는 최초 검색의 상위 5건을 근거로 실시간 AI 안내 1건 (SPEC §9).
 *
 * `/api/match` 에서 떼어낸 이유: 한 응답에 묶으면 이미 계산된 카드가 OpenRouter 응답
 * (최대 12초)을 기다리는 동안 화면에 못 나온다. 결과 화면은 카드를 먼저 그린 뒤 이 라우트를
 * 부르고, 안내가 늦거나 실패해도 카드는 그대로다.
 *
 * 입력은 질의 + 공고 id 뿐이다. 공고 내용은 서버가 다시 읽는다 — 카드 본문을 그대로 받으면
 * 임의 문장을 OpenRouter 로 흘려보내는 통로가 된다. 자유입력은 저장하지 않는다 (§8).
 * Rate limit: 검색과 별도 버킷, 세션 기준 10회/분 (§8).
 */
import { NextResponse } from "next/server";
import { generateLiveAnswer } from "@/lib/live-answer";
import { getPrograms } from "@/lib/matching";
import { readProfile, readSessionId } from "@/lib/session";
import { CSRF_MESSAGE, checkCsrf } from "@/lib/csrf";
import { checkSessionAndIpRateLimit, rateLimitMessage } from "@/lib/rate-limit";
import { validateProgramIds, validateQuery } from "@/lib/validation";
import type { AnswerResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 함수 실행 상한(초). OpenRouter 12초 + 공고 조회 1회에 여유를 더한 값이다. */
export const maxDuration = 20;

export async function POST(req: Request) {
  // CSRF (§8): OpenRouter 호출 비용이 생기므로 크로스사이트 호출을 막는다
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    console.warn(`[api/answer] CSRF 거부 (${csrf.reason})`);
    return NextResponse.json({ ok: false, code: "csrf", message: CSRF_MESSAGE }, { status: 403 });
  }

  const rl = checkSessionAndIpRateLimit(await readSessionId(), req, Date.now(), process.env, "answer");
  if (!rl.allowed) {
    console.warn(`[api/answer] rate limited (scope=${rl.scope}, limit=${rl.limit})`);
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: rateLimitMessage(rl.retryAfter) },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // 검색과 같은 전제 — 프로필 쿠키가 없는 호출은 결과 화면에서 온 것이 아니다.
  if (!(await readProfile())) {
    return NextResponse.json(
      { ok: false, code: "no_profile", message: "먼저 기본 정보를 입력해 주세요." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, errors: [{ field: "body", message: "JSON 형식이 올바르지 않습니다." }] },
      { status: 400 },
    );
  }

  const q = validateQuery(body.query);
  if (!q.ok) {
    return NextResponse.json({ ok: false, errors: q.errors }, { status: 400 });
  }
  const ids = validateProgramIds(body.programIds);
  if (!ids.ok) {
    return NextResponse.json({ ok: false, errors: ids.errors }, { status: 400 });
  }

  try {
    const programs = await getPrograms(ids.value);
    const ai = await generateLiveAnswer({ query: q.value, programs });
    const payload: AnswerResponse & { ok: true } = {
      ok: true,
      aiAnswer: ai.text,
      aiAnswerStatus: ai.status,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/answer] 안내 생성 실패", e);
    // 안내는 부가 기능이다 — 실패를 200 + unavailable 로 알려 카드 화면이 오류로 바뀌지 않게 한다.
    const payload: AnswerResponse & { ok: true } = {
      ok: true,
      aiAnswer: null,
      aiAnswerStatus: "unavailable",
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }
}
