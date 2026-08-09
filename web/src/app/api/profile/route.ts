/**
 * POST /api/profile — 인적사항 5필드 → 익명 프로필 생성 + 세션 쿠키 발급 (SPEC §9).
 *
 * 개인정보 최소화 (§8): 이름·연락처·주민번호를 받지 않는다.
 * 프로필은 httpOnly 쿠키에 담고, DB 가 연결돼 있으면 profiles 에도 익명 행을 남긴다
 * (알림 기능과 90일 자동 삭제 대상 관리를 위해).
 */
import { NextResponse } from "next/server";
import { getSql, isDbConfigured } from "@/lib/db";
import { readOrCreateSessionId, readSessionId, writeProfile } from "@/lib/session";
import { checkRequestLimits } from "@/lib/rate-limit";
import { validateProfile } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // 이 라우트가 세션을 발급하므로 여기에 한도가 없으면 '세션을 새로 받아
  // 다른 라우트의 세션 한도를 초기화하는' 경로가 열린다. 세션 발급 **전에**
  // 검사해야 하므로 쿠키를 읽기만 한다 (readOrCreateSessionId 는 아래에서).
  const rl = checkRequestLimits(await readSessionId(), req, "profile");
  if (!rl.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        message: `요청이 너무 잦습니다. ${rl.retryAfter}초 후에 다시 시도해 주세요.`,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, errors: [{ field: "body", message: "JSON 형식이 올바르지 않습니다." }] },
      { status: 400 },
    );
  }

  const result = validateProfile(body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }
  const profile = result.value;

  const sessionId = await readOrCreateSessionId();
  await writeProfile(profile);

  let persisted = false;
  if (isDbConfigured()) {
    try {
      const sql = getSql();
      if (sql) {
        // region_code 는 가장 구체적인 값(시군구 5자리)을 저장한다.
        await sql`
          INSERT INTO profiles (id, age, gender, occupation, region_code, income_decile, created_at)
          VALUES (
            ${sessionId}::uuid, ${profile.age}, ${profile.gender},
            ${profile.occupation}, ${profile.sigunguCode}, ${profile.incomeDecile}, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            age = EXCLUDED.age,
            gender = EXCLUDED.gender,
            occupation = EXCLUDED.occupation,
            region_code = EXCLUDED.region_code,
            income_decile = EXCLUDED.income_decile`;
        persisted = true;
      }
    } catch (e) {
      // DB 장애가 서비스 중단으로 번지지 않게 한다 — 쿠키만으로도 검색은 동작한다.
      console.error("[api/profile] profiles 저장 실패", e);
    }
  }

  return NextResponse.json({
    ok: true,
    sessionId,
    profile,
    persisted,
    demoMode: !isDbConfigured(),
  });
}
