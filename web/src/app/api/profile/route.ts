/**
 * GET/POST /api/profile — 저장된 프로필 복원 또는 익명 프로필 생성 (SPEC §9).
 *
 * 개인정보 최소화 (§8): 이름·연락처·주민번호를 받지 않는다.
 * 프로필은 암호화한 httpOnly 쿠키에만 담고 서버에 저장하지 않는다 (수명 90일, session.ts).
 * DB 는 공공 API 에서 수집한 지원사업 데이터만 보관한다.
 */
import { NextResponse } from "next/server";
import { readOrCreateSessionId, readProfile, readSessionId, writeProfile } from "@/lib/session";
import { CSRF_MESSAGE, checkCsrf } from "@/lib/csrf";
import { checkSessionAndIpRateLimit, rateLimitMessage } from "@/lib/rate-limit";
import { validateProfile } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await readProfile();
  return profile
    ? NextResponse.json(
        { ok: true, profile },
        { headers: { "Cache-Control": "no-store" } },
      )
    : NextResponse.json(
        { ok: false, code: "no_profile" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
}

export async function POST(req: Request) {
  // CSRF (§8): 크로스사이트에서 피해자의 프로필을 몰래 바꿔치기하는 것을 막는다
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    console.warn(`[api/profile] CSRF 거부 (${csrf.reason})`);
    return NextResponse.json({ ok: false, code: "csrf", message: CSRF_MESSAGE }, { status: 403 });
  }

  // Rate limit (§8): 외부 호출은 없지만 세션 쿠키를 발급하는 유일한 쓰기 경로다.
  // `/api/match` 와 같은 버킷을 쓴다 — 한 사람의 API 예산은 하나이고, 온보딩은 검색 전에
  // 한 번 지나가는 경로라 개인 한도(10회/분)를 실질적으로 소모하지 않는다.
  // 세션 쿠키가 아직 없는 첫 방문은 IP 단위 익명 한도로 센다.
  const rl = checkSessionAndIpRateLimit(await readSessionId(), req);
  if (!rl.allowed) {
    console.warn(`[api/profile] rate limited (scope=${rl.scope}, limit=${rl.limit})`);
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: rateLimitMessage(rl.retryAfter) },
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

  // 세션 id 는 rate limit 키로만 쓴다. 프로필 자체는 쿠키에만 있다.
  await readOrCreateSessionId();
  await writeProfile(profile);

  return NextResponse.json({ ok: true, profile });
}
