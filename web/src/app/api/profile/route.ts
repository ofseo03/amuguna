/**
 * POST /api/profile — 인적사항 5필드 → 익명 프로필 생성 + 세션 쿠키 발급 (SPEC §9).
 *
 * 개인정보 최소화 (§8): 이름·연락처·주민번호를 받지 않는다.
 * 프로필은 서명한 httpOnly 쿠키에만 담고 서버에 저장하지 않는다 (수명 90일, session.ts).
 * DB 는 공공 API 에서 수집한 지원사업 데이터만 보관한다.
 */
import { NextResponse } from "next/server";
import { readOrCreateSessionId, writeProfile } from "@/lib/session";
import { validateProfile } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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

  // 세션 id 는 rate limit 키로만 쓴다. 프로필 자체는 쿠키에만 있다.
  await readOrCreateSessionId();
  await writeProfile(profile);

  return NextResponse.json({ ok: true, profile });
}
