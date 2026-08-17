/**
 * POST /api/match — 카드 리스트(스코어순) + 근접탈락 + 완화 단계 + 페이지 커서 (SPEC §9).
 *
 * 자유입력은 이 요청 시점에만 사용하고 저장하지 않는다 (§8).
 * 요청 경로에 LLM 은 없다 (§7.5) — 임베딩 1회 + 조회 1회가 전부다.
 * Rate limit: 익명 세션 + IP 기준 10회/분 (§8).
 */
import { NextResponse } from "next/server";
import { runMatch } from "@/lib/matching";
import { readProfile, readSessionId } from "@/lib/session";
import { checkSessionAndIpRateLimit } from "@/lib/rate-limit";
import { validateCursor, validateForm, validateQuery } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sessionId = await readSessionId();

  const rl = checkSessionAndIpRateLimit(sessionId, req);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        message: `검색이 너무 잦습니다. ${rl.retryAfter}초 후에 다시 시도해 주세요.`,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

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
