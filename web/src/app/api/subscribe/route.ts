/** POST /api/subscribe — double opt-in 알림 신청. */
import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { confirmationHtml, emailConfigFromEnv, sendResend } from "../../../../ingest/notify";
import { getSql, isDbConfigured } from "@/lib/db";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { readOrCreateSessionId, readProfile } from "@/lib/session";
import { validateEmail } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sessionId = await readOrCreateSessionId();
  const rl = checkRateLimit("subscribe:" + rateLimitKey(sessionId, req));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, message: "요청이 너무 잦습니다. " + rl.retryAfter + "초 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const profile = await readProfile();
  if (!profile) {
    return NextResponse.json(
      { ok: false, code: "no_profile", message: "먼저 기본 정보를 입력해 주세요." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
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
      { ok: false, errors: [{ field: "consent", message: "이메일 수집·이용에 동의해 주셔야 신청할 수 있습니다." }] },
      { status: 400 },
    );
  }
  const email = validateEmail(body.email);
  if (!email.ok) return NextResponse.json({ ok: false, errors: email.errors }, { status: 400 });

  if (!isDbConfigured()) {
    return NextResponse.json({
      ok: true,
      demoMode: true,
      message: "데모 모드입니다. 데이터베이스가 연결되어 있지 않아 이메일을 저장하거나 발송하지 않았습니다.",
    });
  }

  try {
    const config = emailConfigFromEnv();
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");

    const sameEmail = await sql<{ id: string; email_confirmed_at: Date | null }[]>`
      SELECT id, email_confirmed_at FROM profiles WHERE lower(email) = lower(${email.value}) LIMIT 1
    `;
    if (sameEmail[0] && sameEmail[0].id !== sessionId) {
      return NextResponse.json(
        { ok: false, message: "이 이메일은 이미 다른 알림 신청에 사용 중입니다." },
        { status: 409 },
      );
    }
    if (sameEmail[0]?.email_confirmed_at) {
      return NextResponse.json({ ok: true, demoMode: false, message: "이미 이메일 확인이 완료된 알림 신청입니다." });
    }

    const confirmationToken = randomBytes(24).toString("base64url");
    const unsubscribeToken = randomBytes(24).toString("base64url");
    await sql`
      DELETE FROM notification_outbox
      WHERE profile_id = ${sessionId}::uuid AND sent_at IS NULL
    `;
    await sql`
      INSERT INTO profiles (
        id, age, gender, occupation, region_code, income_decile, median_income_percent,
        email, unsubscribe_token, confirmation_token, email_confirmed_at, created_at
      )
      VALUES (
        ${sessionId}::uuid, ${profile.age}, ${profile.gender}, ${profile.occupation},
        ${profile.sigunguCode}, ${profile.incomeDecile}, ${profile.medianIncomePercent},
        ${email.value}, ${unsubscribeToken}, ${confirmationToken}, NULL, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        age = EXCLUDED.age, gender = EXCLUDED.gender, occupation = EXCLUDED.occupation,
        region_code = EXCLUDED.region_code, income_decile = EXCLUDED.income_decile,
        median_income_percent = EXCLUDED.median_income_percent, email = EXCLUDED.email,
        unsubscribe_token = EXCLUDED.unsubscribe_token, confirmation_token = EXCLUDED.confirmation_token,
        email_confirmed_at = NULL, created_at = EXCLUDED.created_at
    `;
    const deliveryKey = "confirm:" + sessionId + ":" + confirmationToken;
    const outbox = await sql<{ id: number }[]>`
      INSERT INTO notification_outbox (profile_id, kind, delivery_key)
      VALUES (${sessionId}::uuid, 'confirm', ${deliveryKey})
      ON CONFLICT (delivery_key) DO UPDATE SET delivery_key = notification_outbox.delivery_key
      RETURNING id
    `;
    try {
      await sendResend(config, {
        to: email.value,
        subject: "[아무거나] 이메일 알림 확인",
        html: confirmationHtml(config.appBaseUrl, confirmationToken),
        idempotencyKey: deliveryKey,
      });
      await sql`UPDATE notification_outbox SET sent_at = now(), last_error = NULL WHERE id = ${outbox[0].id}`;
    } catch (error) {
      await sql`UPDATE notification_outbox SET last_error = ${String(error).slice(0, 500)} WHERE id = ${outbox[0]?.id ?? 0}`;
      throw error;
    }
  } catch (error) {
    console.error("[api/subscribe] confirmation delivery failed", error);
    return NextResponse.json(
      { ok: false, message: "확인 이메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    demoMode: false,
    message: "확인 이메일을 보냈습니다. 메일의 링크에서 확인을 완료해 주세요.",
  });
}
