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
import { readOrCreateSessionId, readProfile, readSessionId } from "@/lib/session";
import { checkRequestLimits } from "@/lib/rate-limit";
import { validateEmail } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // 세션을 만들기 **전에** 검사한다. 먼저 발급하면 쿠키를 버릴 때마다 새 세션 =
  // 새 버킷이 되어 한도가 무의미해진다.
  const rl = checkRequestLimits(await readSessionId(), req, "subscribe");
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

  // 프로필이 없으면 매칭 속성이 전부 NULL 인 행이 남는다 — 약속한 '맞춤 알림'을
  // 계산할 근거가 없는 채 이메일만 보관하게 되므로 받지 않는다 (§8 최소 수집).
  const profile = await readProfile();
  if (!profile) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_profile",
        message:
          "맞춤 알림을 보내드리려면 기본 정보가 먼저 필요합니다. 정보를 입력한 뒤 다시 신청해 주세요.",
      },
      { status: 400 },
    );
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

  const sessionId = await readOrCreateSessionId();
  let resubscribed = false;
  try {
    const sql = getSql();
    if (!sql) throw new Error("DB 미연결");

    // profiles 에는 lower(email) 유니크 인덱스가 있다. 같은 사람이 다른 브라우저에서
    // (또는 세션 쿠키 만료 후) 다시 신청하면 ON CONFLICT (id) 로는 잡히지 않아
    // 유니크 위반 → 500 이 된다. 이메일 행을 먼저 갱신해 재신청을 정상 처리한다.
    const refreshExisting = () => sql`
      UPDATE profiles SET
        age = ${profile.age},
        gender = ${profile.gender},
        occupation = ${profile.occupation},
        region_code = ${profile.sigunguCode},
        income_decile = ${profile.incomeDecile},
        unsubscribe_token = ${token}
      WHERE lower(email) = lower(${email.value})
      RETURNING id`;

    const existing = await refreshExisting();
    resubscribed = existing.length > 0;

    if (!resubscribed) {
      try {
        await sql`
          INSERT INTO profiles (id, age, gender, occupation, region_code, income_decile, email, unsubscribe_token, created_at)
          VALUES (
            ${sessionId}::uuid,
            ${profile.age}, ${profile.gender}, ${profile.occupation},
            ${profile.sigunguCode}, ${profile.incomeDecile},
            ${email.value}, ${token}, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            age = EXCLUDED.age,
            gender = EXCLUDED.gender,
            occupation = EXCLUDED.occupation,
            region_code = EXCLUDED.region_code,
            income_decile = EXCLUDED.income_decile,
            email = EXCLUDED.email,
            unsubscribe_token = EXCLUDED.unsubscribe_token`;
      } catch (e) {
        // 위 SELECT-then-INSERT 사이에 다른 요청이 같은 이메일을 넣은 경우.
        if ((e as { code?: string })?.code !== "23505") throw e;
        const retried = await refreshExisting();
        if (retried.length === 0) throw e;
        resubscribed = true;
      }
    }
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
    resubscribed,
    message: resubscribed
      ? "이미 신청하신 이메일입니다. 최신 정보로 갱신했습니다."
      : "알림 신청이 완료되었습니다.",
    unsubscribeToken: token,
  });
}
