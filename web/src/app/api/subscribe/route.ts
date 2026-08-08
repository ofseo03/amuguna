/**
 * POST /api/subscribe — 알림 등록 (SPEC §9, §8 개인정보).
 *
 * 이메일은 알림 신청 시에만 별도 동의를 받아 수집한다. 1클릭 해지 토큰을 함께 발급한다.
 * MVP 범위에서 실제 발송은 하지 않는다 (§11 — 이메일 수집만 먼저).
 *
 * DB 스키마 메모: SPEC §5 profiles 에는 email 만 있다. 1클릭 해지를 하려면
 * unsubscribe_token 컬럼이 필요하다 — DB 팀 추가 필요 항목 (README 참고).
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getSql, isDbConfigured } from "@/lib/db";
import { readOrCreateSessionId, readProfile } from "@/lib/session";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { validateEmail } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sessionId = await readOrCreateSessionId();

  const rl = checkRateLimit(`subscribe:${rateLimitKey(sessionId, req)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, message: `요청이 너무 잦습니다. ${rl.retryAfter}초 후 다시 시도해 주세요.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
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

  if (body.consent !== true) {
    return NextResponse.json(
      {
        ok: false,
        errors: [
          { field: "consent", message: "이메일 수집·이용에 동의해 주셔야 신청할 수 있습니다." },
        ],
      },
      { status: 400 },
    );
  }

  const email = validateEmail(body.email);
  if (!email.ok) {
    return NextResponse.json({ ok: false, errors: email.errors }, { status: 400 });
  }

  const token = randomBytes(24).toString("base64url");

  if (!isDbConfigured()) {
    // 데모 모드 — 저장하지 않고 안내만 돌려준다
    return NextResponse.json({
      ok: true,
      demoMode: true,
      message:
        "데모 모드입니다. 데이터베이스가 연결되어 있지 않아 이메일이 저장되지 않았습니다.",
      unsubscribeToken: token,
    });
  }

  const profile = await readProfile();
  try {
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");
    await sql`
      INSERT INTO profiles (id, age, gender, occupation, region_code, income_decile, email, unsubscribe_token, created_at)
      VALUES (
        ${sessionId}::uuid,
        ${profile?.age ?? null}, ${profile?.gender ?? null}, ${profile?.occupation ?? null},
        ${profile?.sigunguCode ?? null}, ${profile?.incomeDecile ?? null},
        ${email.value}, ${token}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        unsubscribe_token = EXCLUDED.unsubscribe_token`;
  } catch (e) {
    console.error("[api/subscribe] 저장 실패", e);
    return NextResponse.json(
      { ok: false, message: "알림 신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    demoMode: false,
    message: "알림 신청이 완료되었습니다.",
    unsubscribeToken: token,
  });
}
